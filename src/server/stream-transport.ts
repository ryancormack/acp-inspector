import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client';
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
import { WebSocket } from 'ws';
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk';
import type {
  AgentTransport,
  AgentTransportHandlers,
  HttpLaunchSpec,
  WebSocketLaunchSpec,
} from './transport.js';

/**
 * Shared base for the network transports (Streamable HTTP and WebSocket).
 *
 * Both are built on the SDK's uniform {@link Stream}: a `writable` of outbound
 * messages and a `readable` of inbound ones, the same shape `ndJsonStream`
 * produces for stdio. This class owns the plumbing common to both — draining
 * the readable into {@link AgentTransportHandlers.onInboundLine}, writing to the
 * writable, and lifecycle — so the HTTP and WS subclasses only have to build
 * the stream.
 *
 * The inspector's contract is preserved: callers write an exact serialised
 * string, which we parse once to the object the stream wants; inbound objects
 * are re-serialised to the exact string the log records. The SDK transport owns
 * the connection-id / session-id headers and SSE routing, so none of that
 * leaks up here.
 */
abstract class StreamTransport implements AgentTransport {
  private stream: Stream | null = null;
  private writer: WritableStreamDefaultWriter<AnyMessage> | null = null;
  private started = false;
  private connected = false;
  private closed = false;

  constructor(
    readonly spec: HttpLaunchSpec | WebSocketLaunchSpec,
    protected readonly handlers: AgentTransportHandlers,
  ) {}

  /** Build the SDK stream for this transport. Called once, from start(). */
  protected abstract createStream(): Stream;

  /** A human label for the endpoint, used in transport log lines. */
  protected abstract describe(): string;

  start(): void {
    if (this.started) return;
    this.started = true;

    let stream: Stream;
    try {
      stream = this.createStream();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.stream = stream;
    // A stream is live from creation: the SDK opens the connection lazily on the
    // first write (HTTP) or eagerly (WS), but either way it is usable now.
    this.connected = true;
    this.writer = stream.writable.getWriter();
    this.handlers.onTransportLog(`connecting to ${this.describe()}`);
    void this.drain(stream);
  }

  /** Pumps inbound messages until the readable ends or errors. */
  private async drain(stream: Stream): Promise<void> {
    const reader = stream.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        // Re-serialise to the exact string the log and validators expect. A
        // batch array cannot reach here: the HTTP transport rejects batches,
        // and the inspector flags them before they are written.
        this.handlers.onInboundLine(JSON.stringify(value));
      }
      // A clean end of the readable is a normal disconnect, not a crash.
      this.onClosed(null, null);
    } catch (error) {
      // The readable errored: a dropped SSE stream, a socket close, an HTTP
      // failure. Surface it and treat the connection as gone.
      if (!this.closed) {
        this.handlers.onTransportLog(`transport error: ${errorMessage(error)}`);
      }
      this.onClosed(null, null);
    } finally {
      reader.releaseLock();
    }
  }

  write(raw: string): void {
    if (!this.writer || !this.connected) {
      throw new Error('transport is not connected');
    }
    let message: AnyMessage;
    try {
      message = JSON.parse(raw) as AnyMessage;
    } catch (error) {
      throw new Error(`cannot send non-JSON over a network transport: ${errorMessage(error)}`);
    }
    // Writes are fire-and-forget from the caller's view; a rejected write
    // (closed stream, HTTP POST failure) is reported as a transport error
    // rather than thrown back into the command handler.
    void this.writer.write(message).catch((error: unknown) => {
      if (this.closed) return;
      this.handlers.onTransportLog(`send failed: ${errorMessage(error)}`);
      this.fail(error);
    });
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    // Closing the writable tells the SDK transport to tear the connection down
    // (HTTP issues its DELETE; WS closes the socket).
    const writer = this.writer;
    this.writer = null;
    if (writer) {
      void writer.close().catch(() => {
        void writer.abort().catch(() => undefined);
      });
    }
  }

  get pid(): number | undefined {
    return undefined;
  }

  get running(): boolean {
    return this.connected && !this.closed;
  }

  /** A fatal error before or during connection. */
  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.handlers.onError(toError(error));
  }

  /** The connection ended (cleanly or after an error already surfaced). */
  private onClosed(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.handlers.onExit(code, signal);
  }
}

/** ACP over Streamable HTTP, backed by the SDK's `createHttpStream`. */
export class HttpTransport extends StreamTransport {
  constructor(
    readonly spec: HttpLaunchSpec,
    handlers: AgentTransportHandlers,
  ) {
    super(spec, handlers);
  }

  protected createStream(): Stream {
    return createHttpStream(this.spec.url, { headers: this.spec.headers });
  }

  protected describe(): string {
    return `${this.spec.url} (Streamable HTTP)`;
  }
}

/** ACP over WebSocket, backed by the SDK's `createWebSocketStream`. */
export class WebSocketTransport extends StreamTransport {
  constructor(
    readonly spec: WebSocketLaunchSpec,
    handlers: AgentTransportHandlers,
  ) {
    super(spec, handlers);
  }

  protected createStream(): Stream {
    // Node has no global WebSocket with header support, so hand the SDK the
    // `ws` constructor — the same library the inspector already uses for its
    // own UI channel.
    return createWebSocketStream(this.spec.url, {
      headers: this.spec.headers,
      WebSocket: WebSocket as unknown as NonNullable<
        Parameters<typeof createWebSocketStream>[1]
      >['WebSocket'],
    });
  }

  protected describe(): string {
    return `${this.spec.url} (WebSocket)`;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
