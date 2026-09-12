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
  /** Combined stdout+stderr, byte-limited (see outputByteLimit). */
  buffer: Buffer;
  truncated: boolean;
  /** null while running; set once the process exits. */
  exitStatus: TerminalExitStatus | null;
  outputByteLimit: number | null;
  /** Resolvers waiting on wait_for_exit. */
  exitWaiters: Array<(status: TerminalExitStatus) => void>;
  released: boolean;
}

/**
 * Backs the ACP `terminal/*` client methods with real child processes.
 *
 * One instance lives per {@link InspectorSession} so terminals are torn down
 * when the agent exits or is relaunched. It mirrors how `fs/*` is serviced:
 * commands run with the real environment (no shell), cwd is confined to the
 * session roots, and output is captured verbatim. The inspector debugs an agent
 * by faithfully being the client the agent talks to, so a terminal must run the
 * agent's actual command — not a virtual/sandboxed reimplementation.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();
  private counter = 0;

  constructor(private readonly allowedRoots: string[]) {}

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
        : null;

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
      buffer: Buffer.alloc(0),
      truncated: false,
      exitStatus: null,
      outputByteLimit,
      exitWaiters: [],
      released: false,
    };
    this.terminals.set(id, record);

    const append = (chunk: Buffer) => {
      record.buffer = Buffer.concat([record.buffer, chunk]);
      this.enforceLimit(record);
    };
    proc.stdout.on('data', append);
    proc.stderr.on('data', append);
    proc.on('error', (error) => {
      // A spawn/runtime failure surfaces as an exit with no code; record the
      // message into the buffer so the agent can see why nothing ran.
      append(Buffer.from(`\n[inspector] terminal process error: ${String(error)}\n`));
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
      output: record.buffer.toString('utf8'),
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
   * Keeps the buffer within outputByteLimit by dropping bytes FROM THE FRONT,
   * per the ACP spec, and nudging the cut to the next UTF-8 lead byte so the
   * retained string never starts mid-character.
   */
  private enforceLimit(record: TerminalRecord): void {
    const limit = record.outputByteLimit;
    if (limit === null || record.buffer.length <= limit) return;
    let cut = record.buffer.length - limit;
    // Advance past continuation bytes (0b10xxxxxx) to a character boundary.
    while (cut < record.buffer.length) {
      const byte = record.buffer[cut];
      if (byte === undefined || (byte & 0xc0) !== 0x80) break;
      cut++;
    }
    record.buffer = record.buffer.subarray(cut);
    record.truncated = true;
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
   * The ACP terminal cwd must be absolute. We additionally confine it to the
   * session roots (mirroring fs/* checkPath) so an agent under development
   * cannot run a command against an arbitrary directory. Absent cwd defaults to
   * the first session root.
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
