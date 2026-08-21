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
  type ExtensionUse,
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
  /** In-flight `session/prompt` requests, keyed by request id. */
  private readonly promptIds = new Map<string, { sessionId: string | null; sentAt: number }>();
  /** Prompt request ids we have asked the agent to cancel. */
  private readonly cancelledPromptIds = new Set<string>();
  /** Vendor extension methods seen, in first-seen order. */
  private readonly extensions = new Map<string, ExtensionUse>();

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
      activePrompts: this.promptIds.size,
      extensions: [...this.extensions.values()],
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
    this.promptIds.clear();
    this.cancelledPromptIds.clear();
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
      if (method === 'session/prompt') {
        const params = (outbound as { params?: { sessionId?: unknown } }).params;
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null;
        this.promptIds.set(key, { sessionId, sentAt: Date.now() });
      }
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

  /**
   * Cancels the in-flight prompt turn.
   *
   * ACP puts obligations on BOTH sides here, and the client's half is the part
   * that is easy to get wrong: every outstanding `session/request_permission`
   * MUST be answered with the `cancelled` outcome, or the agent is left waiting
   * on a decision that will never come. So this sends `session/cancel`, then
   * closes out the permission requests we are holding, then watches whether the
   * agent honours its own half by answering `session/prompt` with a
   * `cancelled` stop reason.
   */
  cancelTurn(): void {
    if (!this.agent?.running) throw new Error('no agent is running');
    if (this.promptIds.size === 0) throw new Error('no prompt turn is in flight');

    const sessionId =
      [...this.promptIds.values()].find((p) => p.sessionId !== null)?.sessionId ??
      this.sessionId;
    if (sessionId === null) {
      throw new Error('cannot cancel: no session id is known for the in-flight prompt');
    }

    for (const key of this.promptIds.keys()) this.cancelledPromptIds.add(key);

    this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });

    const outstanding = [...this.pending.values()].filter(
      (request) => request.method === 'session/request_permission',
    );
    for (const request of outstanding) {
      this.pending.delete(idKey(request.id));
      this.sendResponse(request.id, { outcome: { outcome: 'cancelled' } }, undefined);
    }
    if (outstanding.length > 0) {
      this.note(
        `answered ${outstanding.length} pending permission request(s) with the cancelled outcome, as cancellation requires`,
      );
    }
    this.pushState();
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
    const method = 'method' in message ? message.method : undefined;

    const isExtension = method !== undefined && isExtensionMethod(method);
    if (isExtension && method !== undefined) {
      this.recordExtension(method, kind === 'request' ? 'request' : 'notification');
    }

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
      method,
      id: 'id' in message ? message.id : undefined,
      durationMs,
      ...(isExtension ? { extension: true } : {}),
      violations: orUndefined(violations),
    });

    if (kind === 'request' || kind === 'notification') {
      void this.dispatchIncoming(message as { method: string; params?: unknown; id?: JsonRpcId });
    }
  }

  /** Learns negotiated state from responses to requests we care about. */
  private absorbResponse(key: string, message: JsonRpcMessage): void {
    const promptWasCancelled = this.cancelledPromptIds.delete(key);
    const wasPrompt = this.promptIds.delete(key);
    if (wasPrompt) this.pushState();

    if (!('result' in message) || message.result === undefined) return;
    const result = message.result as Record<string, unknown>;

    if (wasPrompt && promptWasCancelled) {
      // The spec is specific: after session/cancel the agent must settle the
      // original prompt with the cancelled stop reason.
      const stopReason = result.stopReason;
      if (stopReason !== 'cancelled') {
        this.note(
          `agent answered a cancelled prompt turn with stopReason ${JSON.stringify(
            stopReason,
          )}; ACP requires "cancelled"`,
        );
      }
    }

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
      // A notification we do not handle is usually fine to drop: ACP reserves
      // `_`-prefixed methods for vendor extensions and says `$/` notifications
      // may be ignored outright. Kiro CLI, for instance, streams a steady flow
      // of `_kiro.dev/*` notifications, and a complaint per frame would bury
      // the log in the inspector's own noise. An unknown notification that is
      // NOT one of those is worth a line, because it is more likely a typo in a
      // real method name than a deliberate extension.
      if (outcome.kind === 'error' && !isIgnorableNotification(message.method)) {
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

  /**
   * Notes a vendor extension the first time it is seen, then just counts it.
   *
   * The agent is entitled to send these, so they are not violations. But an
   * agent that speaks non-standard methods is a fact worth surfacing once:
   * anything relying on them will not work against a different client.
   */
  private recordExtension(method: string, kind: 'request' | 'notification'): void {
    const existing = this.extensions.get(method);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }
    this.extensions.set(method, { method, count: 1, firstSeq: this.seq + 1, kind });
    this.note(`vendor extension ${kind} ${method} (outside the ACP spec)`);
    this.pushState();
  }

  private failAllOutstanding(reason: string): void {
    this.promptIds.clear();
    this.cancelledPromptIds.clear();
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

/**
 * Catches a session-scoped call carrying an empty `sessionId`.
 *
 * The schema cannot: ACP types `SessionId` as a bare `string`, so `""` is
 * structurally valid and validation passes it happily. The agent then rejects it
 * with something like `-32603 No session found with id`, which reads as an agent
 * fault when it is actually a call made before `session/new` returned. This is
 * exactly the kind of check an inspector should own rather than defer to the
 * schema.
 *
 * Only the empty case is flagged. A non-empty id we have never seen is normal:
 * `session/load` and `session/resume` legitimately reference sessions created in
 * an earlier run.
 */
function sessionScopeProblems(record: Record<string, unknown>): string[] {
  const params = record.params;
  if (typeof params !== 'object' || params === null) return [];
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  if (sessionId !== '') return [];
  return [
    `${String(record.method)} carries an empty sessionId; create one with session/new first`,
  ];
}

function idKey(id: JsonRpcId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${String(id)}`;
}

/**
 * ACP reserves a leading `_` on a method name or on any path segment for
 * implementation-specific extensions, so `_kiro.dev/metadata` and
 * `session/_vendor` are both extensions rather than spec methods.
 */
function isExtensionMethod(method: string): boolean {
  return method.startsWith('_') || method.includes('/_');
}

/**
 * Whether an unhandled notification can be dropped without comment. Vendor
 * extensions are legal traffic, and the spec says `$/` notifications may be
 * ignored outright. Anything else is more likely a typo than a deliberate
 * extension, so it still earns a line.
 */
function isIgnorableNotification(method: string): boolean {
  return isExtensionMethod(method) || method.startsWith('$/');
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
    problems.push(...sessionScopeProblems(record));
  }

  if (dir === 'in' && isRequest(message) && message.method === 'initialize') {
    problems.push('initialize is a client -> agent method; the agent should not send it');
  }

  return problems;
}
