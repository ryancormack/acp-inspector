/**
 * The seam between the inspector and whatever carries ACP to the agent.
 *
 * Historically that was always a subprocess over stdio. The inspector only ever
 * needed a handful of things from it — start it, write one serialised message,
 * kill it, ask whether it is running — plus four callbacks for what comes back.
 * That small surface is captured here as {@link AgentTransport} so the session
 * layer can drive a stdio subprocess, a Streamable HTTP endpoint, or a
 * WebSocket endpoint without caring which.
 *
 * Every transport preserves the inspector's core discipline: the caller hands
 * over an exact serialised JSON-RPC string, and inbound traffic is delivered as
 * the exact string it arrived as, so the log and the wire can never disagree.
 */

/** How to reach the agent. Discriminated so the session can pick a transport. */
export type AgentLaunchSpec = StdioLaunchSpec | HttpLaunchSpec | WebSocketLaunchSpec;

export interface StdioLaunchSpec {
  kind: 'stdio';
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface HttpLaunchSpec {
  kind: 'http';
  /** The agent's Streamable HTTP endpoint. */
  url: string;
  /** Static headers sent on every HTTP/SSE request (e.g. Authorization). */
  headers: Record<string, string>;
  /**
   * Local working directory. Over a remote transport the agent does not run
   * here, but this still fills `session/new` params and bounds the inspector's
   * own fs/terminal servicing.
   */
  cwd: string;
}

export interface WebSocketLaunchSpec {
  kind: 'websocket';
  /** The agent's WebSocket endpoint (ws:// or wss://). */
  url: string;
  /** Static headers sent on the upgrade request (Node `ws` honours these). */
  headers: Record<string, string>;
  /** See {@link HttpLaunchSpec.cwd}. */
  cwd: string;
}

export interface AgentTransportHandlers {
  /**
   * One inbound ACP message, serialised exactly as it arrived. For stdio this
   * is a line off stdout; for HTTP/WS it is one JSON-RPC message re-serialised
   * from the stream. Fed into the same parse/validate path regardless.
   */
  onInboundLine: (line: string) => void;
  /**
   * Out-of-band transport logging. For stdio this is a stderr line; for HTTP/WS
   * it is a human-readable note about the connection (opened, closed, errored).
   */
  onTransportLog: (line: string) => void;
  /** The connection ended. `code`/`signal` are stdio-only; undefined otherwise. */
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** The connection could not be established, or failed fatally. */
  onError: (error: Error) => void;
}

export interface AgentTransport {
  /** The spec this transport was built from, for state reporting. */
  readonly spec: AgentLaunchSpec;
  /** Begin connecting / spawning. Non-blocking: results arrive via handlers. */
  start(): void;
  /** Write one serialised JSON-RPC message to the agent. */
  write(raw: string): void;
  /** Best-effort teardown. */
  kill(signal?: NodeJS.Signals): void;
  /** Process id, for stdio only. Undefined for network transports. */
  readonly pid: number | undefined;
  /** Whether the transport is currently connected / the process is alive. */
  readonly running: boolean;
}
