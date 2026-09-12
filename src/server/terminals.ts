import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalExitStatus,
  TerminalOutputResponse,
} from '@agentclientprotocol/sdk';

/**
 * Default retained-output cap when the agent omits `outputByteLimit`.
 *
 * The ACP field is optional, and without a ceiling a chatty or streaming
 * subprocess (a verbose build, `tail -f`) held open until release would grow
 * the retained buffer without bound. 1 MiB is generous for a debugger's
 * "what did this command print" use while keeping memory predictable; an agent
 * that wants more can pass a larger `outputByteLimit`.
 */
const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;

/**
 * Distinguishes a caller error (bad params, unknown terminal id) from an
 * internal fault so the handler can map it to the right JSON-RPC error code.
 */
export class TerminalError extends Error {
  constructor(
    readonly kind: 'not-found' | 'invalid-params',
    message: string,
  ) {
    super(message);
    this.name = 'TerminalError';
  }
}

interface TerminalRecord {
  id: string;
  proc: ChildProcessByStdio<null, Readable, Readable>;
  /**
   * Combined stdout+stderr as a chunk list, byte-limited (see outputByteLimit).
   * Kept as an array so appends are O(1); it is concatenated once, lazily, when
   * output() is read — never on the hot data path.
   */
  chunks: Buffer[];
  /** Running total of bytes currently retained in {@link chunks}. */
  byteLength: number;
  truncated: boolean;
  /** null while running; set once the process exits. */
  exitStatus: TerminalExitStatus | null;
  /** Always a positive number — the request value, or the default cap. */
  outputByteLimit: number;
  /** Resolvers waiting on wait_for_exit. */
  exitWaiters: Array<(status: TerminalExitStatus) => void>;
  released: boolean;
}

/**
 * Backs the ACP `terminal/*` client methods with real child processes.
 *
 * One instance lives per {@link InspectorSession} so terminals are torn down
 * when the agent exits or is relaunched. It mirrors how `fs/*` is serviced:
 * commands run with the real environment (no shell), and the cwd is confined to
 * the session roots. NOTE: only the cwd is confined — `command` and `args` are
 * NOT restricted, so an advertised terminal capability grants the agent full
 * command execution with the inspector's own privileges. The safety property
 * rests entirely on the repo's "only run agents you trust" assumption. The
 * inspector debugs an agent by faithfully being the client the agent talks to,
 * so a terminal must run the agent's actual command — not a virtual/sandboxed
 * reimplementation.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();
  private counter = 0;

  /**
   * @param allowedRoots directories a terminal cwd may resolve into.
   * @param onNote optional sink for lifecycle notes (e.g. a spawned process
   *   error) so they surface in the inspector's frame log, not only in the
   *   terminal's own output buffer.
   */
  constructor(
    private readonly allowedRoots: string[],
    private readonly onNote?: (message: string) => void,
  ) {}

  create(params: CreateTerminalRequest | undefined): CreateTerminalResponse {
    if (!params || typeof params.command !== 'string' || params.command.length === 0) {
      throw new TerminalError('invalid-params', 'command must be a non-empty string');
    }

    const cwd = this.resolveCwd(params.cwd ?? undefined);
    const env = this.buildEnv(params.env);
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const outputByteLimit =
      typeof params.outputByteLimit === 'number' && params.outputByteLimit > 0
        ? Math.floor(params.outputByteLimit)
        : DEFAULT_OUTPUT_BYTE_LIMIT;

    const id = `term-${++this.counter}`;

    // No shell: argv is passed straight through, exactly as fs/* avoids shell
    // interpolation. An agent that wants a shell can spawn one explicitly.
    let proc: ChildProcessByStdio<null, Readable, Readable>;
    try {
      proc = spawn(params.command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      throw new TerminalError('invalid-params', `failed to spawn command: ${String(error)}`);
    }

    const record: TerminalRecord = {
      id,
      proc,
      chunks: [],
      byteLength: 0,
      truncated: false,
      exitStatus: null,
      outputByteLimit,
      exitWaiters: [],
      released: false,
    };
    this.terminals.set(id, record);

    // O(1) per chunk: push and enforce the cap by dropping whole leading chunks,
    // rather than reallocating the full buffer on every write.
    const append = (chunk: Buffer) => {
      record.chunks.push(chunk);
      record.byteLength += chunk.length;
      this.enforceLimit(record);
    };
    proc.stdout.on('data', append);
    proc.stderr.on('data', append);
    proc.on('error', (error) => {
      // A spawn/runtime failure (e.g. ENOENT for a missing binary) surfaces
      // here. Record it in the buffer so the agent can see why nothing ran, AND
      // note it so it shows in the inspector's own frame log — create() has
      // already returned a terminalId, so without this the failure would be
      // invisible to an operator watching the log.
      append(Buffer.from(`\n[inspector] terminal process error: ${String(error)}\n`));
      this.onNote?.(`terminal ${id} process error: ${String(error)}`);
    });
    proc.on('exit', (code, signal) => {
      const status: TerminalExitStatus = {
        exitCode: code,
        signal: signal ?? null,
      };
      record.exitStatus = status;
      for (const w of record.exitWaiters.splice(0)) w(status);
    });

    return { terminalId: id };
  }

  output(terminalId: string | undefined): TerminalOutputResponse {
    const record = this.require(terminalId);
    return {
      output: Buffer.concat(record.chunks, record.byteLength).toString('utf8'),
      truncated: record.truncated,
      exitStatus: record.exitStatus ?? undefined,
    };
  }

  async waitForExit(terminalId: string | undefined): Promise<TerminalExitStatus> {
    const record = this.require(terminalId);
    if (record.exitStatus) return record.exitStatus;
    return new Promise<TerminalExitStatus>((res) => {
      record.exitWaiters.push(res);
    });
  }

  kill(terminalId: string | undefined): void {
    const record = this.require(terminalId);
    if (!record.exitStatus) record.proc.kill('SIGKILL');
  }

  release(terminalId: string | undefined): void {
    const record = this.require(terminalId);
    if (!record.exitStatus) record.proc.kill('SIGKILL');
    record.released = true;
    this.terminals.delete(record.id);
  }

  /** Kill and forget every terminal — called when the agent exits/relaunches. */
  releaseAll(): void {
    for (const record of this.terminals.values()) {
      if (!record.exitStatus) {
        try {
          record.proc.kill('SIGKILL');
        } catch {
          // process already gone
        }
      }
      record.released = true;
    }
    this.terminals.clear();
  }

  private require(terminalId: string | undefined): TerminalRecord {
    if (typeof terminalId !== 'string' || terminalId.length === 0) {
      throw new TerminalError('invalid-params', 'terminalId must be a non-empty string');
    }
    const record = this.terminals.get(terminalId);
    if (!record) {
      throw new TerminalError('not-found', `unknown terminalId: ${terminalId}`);
    }
    return record;
  }

  /**
   * Keeps retained output within outputByteLimit by dropping bytes FROM THE
   * FRONT, per the ACP spec, nudging the cut to the next UTF-8 lead byte so the
   * retained string never starts mid-character. Operates on the chunk list:
   * whole leading chunks are dropped first, then the new leading chunk is
   * trimmed — so the hot path never rescans the whole buffer.
   */
  private enforceLimit(record: TerminalRecord): void {
    const limit = record.outputByteLimit;
    if (record.byteLength <= limit) return;

    // Drop whole leading chunks while doing so still leaves us over the limit.
    while (record.chunks.length > 1 && record.byteLength - record.chunks[0]!.length >= limit) {
      record.byteLength -= record.chunks.shift()!.length;
    }
    record.truncated = true;

    // Trim the (single) leading chunk down to the remaining allowance, at a
    // UTF-8 character boundary.
    const overflow = record.byteLength - limit;
    if (overflow > 0 && record.chunks.length > 0) {
      const head = record.chunks[0]!;
      let cut = overflow;
      while (cut < head.length) {
        const byte = head[cut];
        if (byte === undefined || (byte & 0xc0) !== 0x80) break;
        cut++;
      }
      record.chunks[0] = head.subarray(cut);
      record.byteLength -= cut;
    }
  }

  private buildEnv(env: CreateTerminalRequest['env']): NodeJS.ProcessEnv {
    const merged: NodeJS.ProcessEnv = { ...process.env };
    if (Array.isArray(env)) {
      for (const item of env) {
        if (item && typeof item.name === 'string') merged[item.name] = String(item.value ?? '');
      }
    }
    return merged;
  }

  /**
   * The ACP terminal cwd must be absolute. We additionally confine the cwd to
   * the session roots (mirroring fs/* checkPath). This narrows only WHERE a
   * command starts — it does NOT restrict which binary runs or what it touches
   * (command/args are unconfined), so it is not a sandbox. Absent cwd defaults
   * to the first session root.
   */
  private resolveCwd(cwd: string | undefined): string {
    if (cwd === undefined) return this.allowedRoots[0] ?? process.cwd();
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new TerminalError('invalid-params', `cwd must be an absolute path: ${cwd}`);
    }
    const resolved = resolve(cwd);
    const inRoot = this.allowedRoots.some((root) => {
      const rel = relative(resolve(root), resolved);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
    if (!inRoot) {
      throw new TerminalError('invalid-params', `cwd is outside the session roots: ${resolved}`);
    }
    return resolved;
  }
}
