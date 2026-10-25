import { spawn, type ChildProcess } from 'node:child_process';
import { LineSplitter } from './ndjson.js';
import type {
  AgentTransport,
  AgentTransportHandlers,
  StdioLaunchSpec,
} from './transport.js';

/**
 * Owns the agent subprocess and its three pipes — the original ACP transport.
 *
 * Deliberately thin: it does not parse, validate, or interpret anything. The
 * inspector needs the bytes as they were, so parsing happens a layer up and
 * never replaces the captured line.
 *
 * stdout lines become inbound ACP messages; stderr lines are transport logging;
 * the process exiting or failing to spawn are the exit/error signals. This is
 * the stdio implementation of {@link AgentTransport}.
 */
export class StdioTransport implements AgentTransport {
  private child: ChildProcess | null = null;
  private readonly stdout: LineSplitter;
  private readonly stderr: LineSplitter;
  private exited = false;

  constructor(
    readonly spec: StdioLaunchSpec,
    private readonly handlers: AgentTransportHandlers,
  ) {
    this.stdout = new LineSplitter(handlers.onInboundLine);
    this.stderr = new LineSplitter(handlers.onTransportLog);
  }

  start(): void {
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: { ...process.env, ...this.spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // No shell: the command and its args are passed through as an argv array
      // so a value containing a space or a quote cannot become a second command.
      shell: false,
    });
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.stdout.push(chunk));
    child.stderr?.on('data', (chunk: string) => this.stderr.push(chunk));

    child.on('error', (error) => {
      this.exited = true;
      this.handlers.onError(error);
    });

    child.on('exit', (code, signal) => {
      this.exited = true;
      this.stdout.flush();
      this.stderr.flush();
      this.handlers.onExit(code, signal);
    });

    // A crashing agent usually means we are mid-write; swallow EPIPE so the
    // inspector reports the exit rather than dying alongside it.
    child.stdin?.on('error', () => undefined);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  /**
   * Writes one ACP message. The caller supplies the exact serialisation so the
   * log and the wire cannot disagree.
   */
  write(line: string): void {
    if (!this.child?.stdin?.writable) {
      throw new Error('agent stdin is not writable (process not running?)');
    }
    this.child.stdin.write(`${line}\n`);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.child?.kill(signal);
  }
}
