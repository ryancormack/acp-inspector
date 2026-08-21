import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { AgentProcess, type AgentLaunchSpec } from './agent-process.js';
import { handleClientMethod } from './client-methods.js';
import { validateParams } from './validate.js';
import {
  DEFAULT_CAPABILITIES,
  type CapabilityToggles,
  type Direction,
  type FrameKind,
  type InspectorState,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type LogEntry,
  type Negotiated,
  type PendingRequest,
  type ServerEvent,
} from '../shared/wire.js';

const MAX_LOG_ENTRIES = 10_000;

/** Protocol version the inspector offers unless overridden, per the SDK. */
export const DEFAULT_PROTOCOL_VERSION = PROTOCOL_VERSION;

export interface SessionOptions {
  /** Launch spec from argv. Absent when started with no agent command. */
  launchSpec: AgentLaunchSpec | null;
  /** Whether the browser may supply or edit the launch command. */
  allowBrowserSpawn: boolean;
  defaultCwd: string;
}

interface OutstandingOutbound {
  method: string;
  sentAt: number;
}

/**
 * One inspector session: at most one agent subprocess, plus the log of
 * everything that crossed the wire while it was alive.
 */
export class InspectorSession {
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly log: LogEntry[] = [];
  private readonly outstandingOutbound = new Map<string, OutstandingOutbound>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingBroadcast: LogEntry[] = [];

  private agent: AgentProcess | null = null;
  private seq = 0;
  private nextRequestId = 1;
  private dropped = 0;
  private flushScheduled = false;

  private capabilities: CapabilityToggles = { ...DEFAULT_CAPABILITIES };
  private protocolVersion = DEFAULT_PROTOCOL_VERSION;
  private negotiated: Negotiated | null = null;
  private sessionId: string | null = null;
  private lastExit: { code: number | null; signal: string | null } | undefined;

  /** Request ids we are watching so we can learn state from their responses. */
  private readonly initializeIds = new Set<string>();
  private readonly newSessionIds = new Set<string>();

  constructor(private readonly options: SessionOptions) {}

  /* ------------------------------------------------------------- subscriptions */

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: 'hello', state: this.state(), log: [...this.log] });
    return () => this.listeners.delete(listener);
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  state(): InspectorState {
    const spec = this.agent?.spec ?? this.options.launchSpec;
    return {
      agent: {
        running: this.agent?.running ?? false,
        pid: this.agent?.pid,
        command: spec?.command,
        args: spec?.args,
        cwd: spec?.cwd ?? this.options.defaultCwd,
        exit: this.lastExit,
        spawnFromBrowserAllowed: this.options.allowBrowserSpawn,
      },
      capabilities: this.capabilities,
      protocolVersion: this.protocolVersion,
      negotiated: this.negotiated,
      sessionId: this.sessionId,
      pending: [...this.pending.values()],
      dropped: this.dropped,
    };
  }

  private pushState(): void {
    this.emit({ type: 'state', state: this.state() });
  }

  /* -------------------------------------------------------------------- logging */

  private record(entry: Omit<LogEntry, 'seq' | 'ts'> & { ts?: number }): LogEntry {
    const full: LogEntry = { ...entry, seq: ++this.seq, ts: entry.ts ?? Date.now() };
    this.log.push(full);
    if (this.log.length > MAX_LOG_ENTRIES) {
      this.log.splice(0, this.log.length - MAX_LOG_ENTRIES);
      this.dropped += 1;
    }
    this.pendingBroadcast.push(full);
    this.scheduleFlush();
    return full;
  }

  /**
   * Batches log frames per tick. A chatty `session/update` stream would
   * otherwise produce a websocket frame per token.
   */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      if (this.pendingBroadcast.length === 0) return;
      const entries = this.pendingBroadcast.splice(0, this.pendingBroadcast.length);
      this.emit({ type: 'log', entries });
    });
  }

  private note(text: string, dir: Direction = 'meta'): void {
    this.record({ dir, kind: 'meta', raw: text });
  }

  clear(): void {
    this.log.length = 0;
    this.dropped = 0;
    this.emit({ type: 'cleared' });
  }

  /* ------------------------------------------------------------------- lifecycle */

  launch(override?: Partial<AgentLaunchSpec>): void {
    if (this.agent?.running) throw new Error('an agent is already running');

    const base = this.options.launchSpec;
    if (override && !this.options.allowBrowserSpawn) {
      const changesCommand =
        (override.command !== undefined && override.command !== base?.command) ||
        (override.args !== undefined &&
          JSON.stringify(override.args) !== JSON.stringify(base?.args));
      if (changesCommand) {
        throw new Error(
          'editing the launch command from the browser is disabled; restart with --allow-browser-spawn',
        );
      }
    }

    const spec: AgentLaunchSpec = {
      command: override?.command ?? base?.command ?? '',
      args: override?.args ?? base?.args ?? [],
      cwd: override?.cwd ?? base?.cwd ?? this.options.defaultCwd,
      env: { ...(base?.env ?? {}), ...(override?.env ?? {}) },
    };
    if (!spec.command) {
      throw new Error('no agent command configured; pass one after `--` on the command line');
    }

    this.outstandingOutbound.clear();
    this.pending.clear();
    this.initializeIds.clear();
    this.newSessionIds.clear();
    this.negotiated = null;
    this.sessionId = null;
    this.lastExit = undefined;

    const agent = new AgentProcess(spec, {
      onStdoutLine: (line) => this.onAgentLine(line),
      onStderrLine: (line) => this.record({ dir: 'stderr', kind: 'stderr', raw: line }),
      onExit: (code, signal) => {
        this.lastExit = { code, signal };
        this.note(`agent exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
        this.failAllOutstanding('agent exited');
        this.pushState();
      },
      onSpawnError: (error) => {
        this.note(`failed to spawn agent: ${error.message}`);
        this.pushState();
      },
    });

    this.agent = agent;
    agent.start();
    this.note(`spawned ${spec.command} ${spec.args.join(' ')} (cwd=${spec.cwd})`);
    this.pushState();
  }

  kill(): void {
    this.agent?.kill();
  }

  setCapabilities(capabilities: CapabilityToggles): void {
    this.capabilities = capabilities;
    this.note(`client capabilities set to ${JSON.stringify(capabilities)}`);
    this.pushState();
  }

  setProtocolVersion(version: number): void {
    this.protocolVersion = version;
    this.pushState();
  }

  /* ------------------------------------------------------------------- outbound */

  /**
   * Sends a message to the agent.
   *
   * With `assignId` the server stamps the next request id. Without it the
   * message is serialised exactly as composed, so a deliberately malformed
   * frame (no `jsonrpc`, a duplicate id, a string id) reaches the agent intact.
   * That is a feature: half of debugging an agent is seeing how it reacts to
   * traffic a well-behaved editor would never send.
   */
  send(message: JsonRpcMessage, assignId = false): void {
    if (!this.agent?.running) throw new Error('no agent is running');

    const draft: Record<string, unknown> = { ...(message as unknown as Record<string, unknown>) };
    if (assignId && typeof draft.method === 'string') {
      draft.id = this.nextRequestId++;
    }
    const outbound = draft as unknown as JsonRpcMessage;

    const raw = JSON.stringify(outbound);
    const kind = classifyKind(outbound);

    if (kind === 'request' && 'id' in outbound && outbound.id !== null) {
      const key = idKey(outbound.id);
      const method = (outbound as { method: string }).method;
      this.outstandingOutbound.set(key, { method, sentAt: Date.now() });
      if (method === 'initialize') this.initializeIds.add(key);
      if (method === 'session/new' || method === 'session/load') this.newSessionIds.add(key);
    }

    this.agent.write(raw);
    this.record({
      dir: 'out',
      kind,
      raw,
      msg: outbound,
      method: 'method' in outbound ? outbound.method : undefined,
      id: 'id' in outbound ? outbound.id : undefined,
      violations: orUndefined(problemsFor(outbound, 'out', kind)),
    });
  }

  /** Answers an agent-initiated request that was deferred to the human. */
  respond(id: JsonRpcId, result: unknown, error: JsonRpcError | undefined): void {
    const key = idKey(id);
    if (!this.pending.has(key)) {
      throw new Error(`no pending agent request with id ${key}`);
    }
    this.pending.delete(key);
    this.sendResponse(id, result, error);
    this.pushState();
  }

  private sendResponse(id: JsonRpcId, result: unknown, error: JsonRpcError | undefined): void {
    const message: JsonRpcMessage = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result: result ?? {} };
    const raw = JSON.stringify(message);
    try {
      this.agent?.write(raw);
    } catch (writeError) {
      this.note(`could not answer request ${idKey(id)}: ${String(writeError)}`);
      return;
    }
    this.record({
      dir: 'out',
      kind: error ? 'error' : 'response',
      raw,
      msg: message,
      id,
    });
  }

  /* -------------------------------------------------------------------- inbound */

  private onAgentLine(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // The spec is explicit: the agent MUST NOT write non-ACP output to stdout.
      // A `console.log` in an agent lands here, and it is worth shouting about
      // because it corrupts the stream for every real client too.
      this.record({
        dir: 'in',
        kind: 'malformed',
        raw,
        parseError: (error as Error).message,
        violations: ['stdout carried a line that is not valid JSON; ACP forbids non-ACP stdout'],
      });
      return;
    }

    // ACP v2 permits JSON-RPC batches, which arrive as an array on one line.
    // Each element is logged and dispatched in its own right, with the raw line
    // kept alongside so the framing is still visible.
    if (Array.isArray(parsed)) {
      if (!isBatch(parsed)) {
        this.record({
          dir: 'in',
          kind: 'malformed',
          raw,
          violations: ['array frame is not a valid non-empty JSON-RPC batch'],
        });
        return;
      }
      this.note(`batch of ${parsed.length} message(s) received`, 'in');
      for (const element of parsed) this.ingestMessage(element, JSON.stringify(element));
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      this.record({
        dir: 'in',
        kind: 'malformed',
        raw,
        violations: ['JSON-RPC messages must be objects or batches of objects'],
      });
      return;
    }

    this.ingestMessage(parsed, raw);
  }

  private ingestMessage(parsed: unknown, raw: string): void {
    const message = parsed as JsonRpcMessage;
    const kind = classifyKind(message);
    const violations = problemsFor(message, 'in', kind);

    let durationMs: number | undefined;
    if ((kind === 'response' || kind === 'error') && 'id' in message && message.id !== null) {
      const key = idKey(message.id);
      const outstanding = this.outstandingOutbound.get(key);
      if (outstanding) {
        durationMs = Date.now() - outstanding.sentAt;
        this.outstandingOutbound.delete(key);
        this.absorbResponse(key, message);
      } else {
        violations.push(`response id ${key} does not match any outstanding request`);
      }
    }

    this.record({
      dir: 'in',
      kind,
      raw,
      msg: message,
      method: 'method' in message ? message.method : undefined,
      id: 'id' in message ? message.id : undefined,
      durationMs,
      violations: orUndefined(violations),
    });

    if (kind === 'request' || kind === 'notification') {
      void this.dispatchIncoming(message as { method: string; params?: unknown; id?: JsonRpcId });
    }
  }

  /** Learns negotiated state from responses to requests we care about. */
  private absorbResponse(key: string, message: JsonRpcMessage): void {
    if (!('result' in message) || message.result === undefined) return;
    const result = message.result as Record<string, unknown>;

    if (this.initializeIds.delete(key)) {
      this.negotiated = {
        protocolVersion: Number(result.protocolVersion ?? 0),
        agentCapabilities: result.agentCapabilities,
        agentInfo: result.agentInfo,
        authMethods: result.authMethods,
      };
      this.pushState();
    }

    if (this.newSessionIds.delete(key)) {
      if (typeof result.sessionId === 'string') this.sessionId = result.sessionId;
      this.pushState();
    }
  }

  private async dispatchIncoming(message: {
    method: string;
    params?: unknown;
    id?: JsonRpcId;
  }): Promise<void> {
    const isRequest = message.id !== undefined && message.id !== null;

    let outcome;
    try {
      outcome = await handleClientMethod(message.method, message.params, {
        capabilities: this.capabilities,
        allowedRoots: [this.agent?.spec.cwd ?? this.options.defaultCwd],
      });
    } catch (error) {
      outcome = {
        kind: 'error' as const,
        error: RequestError.internalError(undefined, String(error)).toErrorResponse(),
      };
    }

    if (!isRequest) {
      if (outcome.kind === 'error') {
        this.note(`ignoring unhandled notification ${message.method}: ${outcome.error.message}`);
      }
      return;
    }

    const id = message.id as JsonRpcId;
    switch (outcome.kind) {
      case 'result':
        this.sendResponse(id, outcome.result, undefined);
        return;
      case 'error':
        this.sendResponse(id, undefined, outcome.error);
        return;
      case 'defer':
        this.pending.set(idKey(id), {
          id,
          method: message.method,
          params: message.params,
          receivedAt: Date.now(),
        });
        this.note(`awaiting your answer to ${message.method} (id ${idKey(id)})`);
        this.pushState();
        return;
      case 'none':
        return;
    }
  }

  private failAllOutstanding(reason: string): void {
    if (this.outstandingOutbound.size > 0) {
      const ids = [...this.outstandingOutbound.keys()].join(', ');
      this.note(`${this.outstandingOutbound.size} request(s) never answered (${reason}): ${ids}`);
      this.outstandingOutbound.clear();
    }
    if (this.pending.size > 0) {
      this.note(`${this.pending.size} agent request(s) abandoned unanswered (${reason})`);
      this.pending.clear();
    }
  }
}

function idKey(id: JsonRpcId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${String(id)}`;
}

function orUndefined(list: string[]): string[] | undefined {
  return list.length > 0 ? list : undefined;
}

/**
 * Local JSON-RPC guards.
 *
 * The SDK has equivalents in its `jsonrpc` module but does not re-export them
 * from its public entry point, and its `exports` map has no subpath for the
 * internal file, so they cannot be imported without reaching past the package
 * contract. These few lines are the price of not doing that; the message *types*
 * are still the SDK's, so a shape change upstream is still a type error here.
 */
function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  const record = message as Record<string, unknown>;
  return typeof record.method === 'string' && 'id' in record && record.id !== undefined;
}

function isNotification(message: JsonRpcMessage): boolean {
  const record = message as Record<string, unknown>;
  return typeof record.method === 'string' && (!('id' in record) || record.id === undefined);
}

function isResponse(message: JsonRpcMessage): boolean {
  const record = message as Record<string, unknown>;
  if (typeof record.method === 'string') return false;
  return 'id' in record && ('result' in record || 'error' in record);
}

/** A non-empty array in which every element is a plausible JSON-RPC message. */
function isBatch(value: unknown[]): boolean {
  if (value.length === 0) return false;
  return value.every((element) => {
    if (typeof element !== 'object' || element === null || Array.isArray(element)) return false;
    const record = element as Record<string, unknown>;
    return typeof record.method === 'string' || 'result' in record || 'error' in record;
  });
}

function classifyKind(message: JsonRpcMessage): FrameKind {
  if (isRequest(message)) return 'request';
  if (isNotification(message)) return 'notification';
  if (isResponse(message)) {
    const record = message as Record<string, unknown>;
    return 'error' in record && record.error !== undefined ? 'error' : 'response';
  }
  return 'malformed';
}

/**
 * Protocol problems for one frame: the ACP schema's verdict, plus the few
 * checks a schema cannot express because they are about the conversation rather
 * than the message.
 */
function problemsFor(message: JsonRpcMessage, dir: 'in' | 'out', kind: FrameKind): string[] {
  const problems: string[] = [];

  if (kind === 'malformed') {
    problems.push('not a valid JSON-RPC request, response, or notification');
    return problems;
  }

  const record = message as unknown as Record<string, unknown>;

  if (record.jsonrpc !== '2.0') {
    problems.push(`missing or wrong "jsonrpc" field (got ${JSON.stringify(record.jsonrpc)})`);
  }

  if (typeof record.method === 'string') {
    problems.push(...validateParams(record.method, record.params).problems);
  }

  if (dir === 'in' && isRequest(message) && message.method === 'initialize') {
    problems.push('initialize is a client -> agent method; the agent should not send it');
  }

  return problems;
}
