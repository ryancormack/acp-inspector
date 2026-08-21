/**
 * Types shared by the inspector server and the browser UI.
 *
 * These describe the *control channel* (inspector server <-> browser), not ACP
 * itself. ACP payloads are carried through as opaque JSON so that nothing the
 * agent sends is normalised or dropped on the way to the log.
 *
 * The JSON-RPC shapes are aliased from `@agentclientprotocol/sdk` rather than
 * redeclared. The import is type-only, so the browser bundle gains nothing at
 * runtime, but the inspector's notion of a message stays identical to the
 * library real clients are built on.
 */

import type {
  AnyMessage,
  AnyNotification,
  AnyRequest,
  AnyResponse,
  ErrorResponse,
  JsonRpcId as SdkJsonRpcId,
} from '@agentclientprotocol/sdk';

export type JsonRpcId = SdkJsonRpcId;
export type JsonRpcError = ErrorResponse;
export type JsonRpcRequest = AnyRequest;
export type JsonRpcNotification = AnyNotification;
export type JsonRpcResponse = AnyResponse;
export type JsonRpcMessage = AnyMessage;

/** `out` = inspector -> agent, `in` = agent -> inspector. */
export type Direction = 'out' | 'in' | 'stderr' | 'meta';

export type FrameKind =
  | 'request'
  | 'response'
  | 'error'
  | 'notification'
  | 'stderr'
  | 'meta'
  | 'malformed';

export interface LogEntry {
  seq: number;
  /** Epoch millis, captured at the transport boundary. */
  ts: number;
  dir: Direction;
  kind: FrameKind;
  /** The line exactly as it crossed stdio, before any parsing. */
  raw: string;
  /** Parsed form. Absent when the line was not valid JSON-RPC. */
  msg?: JsonRpcMessage;
  parseError?: string;
  method?: string;
  id?: JsonRpcId;
  /** Round-trip time, set on a response that matched an outstanding request. */
  durationMs?: number;
  /** Protocol problems detected by the inspector (not by the agent). */
  violations?: string[];
}

/**
 * Client capabilities the inspector advertises in `initialize`.
 *
 * Toggling these is the point of the tool: an agent that only ever talks to a
 * permissive editor never exercises its own degraded paths.
 */
export interface CapabilityToggles {
  fsRead: boolean;
  fsWrite: boolean;
  terminal: boolean;
  elicitation: boolean;
  /** Advertise `auth.terminal`, i.e. that we could run the agent interactively. */
  authTerminal: boolean;
}

export const DEFAULT_CAPABILITIES: CapabilityToggles = {
  fsRead: true,
  fsWrite: true,
  terminal: false,
  elicitation: false,
  authTerminal: false,
};

/** An agent-initiated request the inspector is holding open for a human answer. */
export interface PendingRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
  receivedAt: number;
}

export interface AgentStatus {
  running: boolean;
  pid?: number;
  command?: string;
  args?: string[];
  cwd?: string;
  exit?: { code: number | null; signal: string | null };
  /** True when the launch command may be edited from the browser. */
  spawnFromBrowserAllowed: boolean;
}

export interface Negotiated {
  protocolVersion: number;
  agentCapabilities?: unknown;
  agentInfo?: unknown;
  authMethods?: unknown;
}

export interface InspectorState {
  agent: AgentStatus;
  capabilities: CapabilityToggles;
  /** Protocol version the inspector offers in `initialize`. */
  protocolVersion: number;
  negotiated: Negotiated | null;
  /** Most recent session id returned by `session/new` or `session/load`. */
  sessionId: string | null;
  pending: PendingRequest[];
  /** Entries dropped from the head of the ring buffer. */
  dropped: number;
}

/* ---------------------------------------------------------------- server -> UI */

export type ServerEvent =
  | { type: 'hello'; state: InspectorState; log: LogEntry[] }
  | { type: 'log'; entries: LogEntry[] }
  | { type: 'state'; state: InspectorState }
  | { type: 'cleared' }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

/* ---------------------------------------------------------------- UI -> server */

export type ClientCommand =
  | {
      type: 'launch';
      command?: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  | { type: 'kill' }
  /**
   * Send one message to the agent. When `assignId` is true the server stamps
   * the next outbound request id; otherwise the message goes out exactly as
   * composed, which is how you send deliberately malformed traffic.
   */
  | { type: 'send'; message: JsonRpcMessage; assignId?: boolean }
  | { type: 'respond'; id: JsonRpcId; result?: unknown; error?: JsonRpcError }
  | { type: 'capabilities'; capabilities: CapabilityToggles }
  | { type: 'protocolVersion'; version: number }
  | { type: 'clear' };
