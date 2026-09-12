import {
  CLIENT_METHODS,
  PROTOCOL_METHODS,
  RequestError,
  type CreateTerminalRequest,
  type ErrorResponse,
  type KillTerminalRequest,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type TerminalOutputRequest,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { CapabilityToggles } from '../shared/wire.js';
import { TerminalError, TerminalManager } from './terminals.js';

export type HandlerOutcome =
  /** Answer the agent now. */
  | { kind: 'result'; result: unknown }
  | { kind: 'error'; error: ErrorResponse }
  /** Hold the request open for a human to answer from the UI. */
  | { kind: 'defer' }
  /** A notification: nothing to answer. */
  | { kind: 'none' };

export interface HandlerContext {
  capabilities: CapabilityToggles;
  /** Filesystem access is confined to these roots (the session cwd, normally). */
  allowedRoots: string[];
  /** Per-session terminal manager backing the terminal/* methods. */
  terminals: TerminalManager;
}

/**
 * Which client capability gates each agent-initiated request.
 *
 * Keyed off the SDK's `CLIENT_METHODS` rather than string literals so that a
 * method rename or addition upstream is a type error here instead of a silently
 * unhandled request.
 */
const CAPABILITY_GATE: Partial<Record<string, keyof CapabilityToggles>> = {
  [CLIENT_METHODS.fs_read_text_file]: 'fsRead',
  [CLIENT_METHODS.fs_write_text_file]: 'fsWrite',
  [CLIENT_METHODS.terminal_create]: 'terminal',
  [CLIENT_METHODS.terminal_output]: 'terminal',
  [CLIENT_METHODS.terminal_kill]: 'terminal',
  [CLIENT_METHODS.terminal_release]: 'terminal',
  [CLIENT_METHODS.terminal_wait_for_exit]: 'terminal',
  [CLIENT_METHODS.elicitation_create]: 'elicitation',
};

/** Agent -> client notifications, which never get a response. */
const CLIENT_NOTIFICATIONS = new Set<string>([
  CLIENT_METHODS.session_update,
  CLIENT_METHODS.elicitation_complete,
  PROTOCOL_METHODS.cancel_request,
]);

/** Requests we hand to the human rather than answering automatically. */
const DEFERRED = new Set<string>([
  CLIENT_METHODS.session_request_permission,
  CLIENT_METHODS.elicitation_create,
]);

const TERMINAL_METHODS = new Set<string>([
  CLIENT_METHODS.terminal_create,
  CLIENT_METHODS.terminal_output,
  CLIENT_METHODS.terminal_kill,
  CLIENT_METHODS.terminal_release,
  CLIENT_METHODS.terminal_wait_for_exit,
]);

/**
 * Answers, defers, or rejects one agent-initiated message.
 *
 * The gate check runs first and on purpose: if we advertised
 * `fs.readTextFile: false` and the agent calls it anyway, that is the agent's
 * bug and `-32601` is the honest answer. Silently servicing the call would hide
 * exactly the defect the inspector exists to surface.
 */
export async function handleClientMethod(
  method: string,
  params: unknown,
  ctx: HandlerContext,
): Promise<HandlerOutcome> {
  if (CLIENT_NOTIFICATIONS.has(method)) return { kind: 'none' };

  const gate = CAPABILITY_GATE[method];
  if (gate && !ctx.capabilities[gate]) {
    return {
      kind: 'error',
      error: new RequestError(
        RequestError.methodNotFound(method).code,
        `${method} is not available: the client did not advertise the capability for it`,
        { notAdvertised: gate },
      ).toErrorResponse(),
    };
  }

  if (DEFERRED.has(method)) return { kind: 'defer' };

  if (method === CLIENT_METHODS.fs_read_text_file) {
    return readTextFile(params as ReadTextFileRequest, ctx);
  }
  if (method === CLIENT_METHODS.fs_write_text_file) {
    return writeTextFile(params as WriteTextFileRequest, ctx);
  }
  if (TERMINAL_METHODS.has(method)) {
    return handleTerminal(method, params, ctx);
  }

  return { kind: 'error', error: RequestError.methodNotFound(method).toErrorResponse() };
}

/**
 * Services the ACP terminal/* methods against the per-session
 * {@link TerminalManager}. A {@link TerminalError} maps to the right JSON-RPC
 * code — a bad param or unknown terminal id is the agent's fault
 * (resourceNotFound / invalidParams), anything else is internal.
 */
async function handleTerminal(
  method: string,
  params: unknown,
  ctx: HandlerContext,
): Promise<HandlerOutcome> {
  try {
    switch (method) {
      case CLIENT_METHODS.terminal_create:
        return { kind: 'result', result: ctx.terminals.create(params as CreateTerminalRequest) };
      case CLIENT_METHODS.terminal_output:
        return {
          kind: 'result',
          result: ctx.terminals.output((params as TerminalOutputRequest | undefined)?.terminalId),
        };
      case CLIENT_METHODS.terminal_wait_for_exit: {
        const status = await ctx.terminals.waitForExit(
          (params as WaitForTerminalExitRequest | undefined)?.terminalId,
        );
        const response: WaitForTerminalExitResponse = {
          exitCode: status.exitCode ?? null,
          signal: status.signal ?? null,
        };
        return { kind: 'result', result: response };
      }
      case CLIENT_METHODS.terminal_kill:
        ctx.terminals.kill((params as KillTerminalRequest | undefined)?.terminalId);
        return { kind: 'result', result: {} };
      case CLIENT_METHODS.terminal_release:
        ctx.terminals.release((params as ReleaseTerminalRequest | undefined)?.terminalId);
        return { kind: 'result', result: {} };
      default:
        return { kind: 'error', error: RequestError.methodNotFound(method).toErrorResponse() };
    }
  } catch (error) {
    if (error instanceof TerminalError) {
      const rpc =
        error.kind === 'not-found'
          ? RequestError.resourceNotFound(error.message)
          : RequestError.invalidParams(undefined, error.message);
      return { kind: 'error', error: rpc.toErrorResponse() };
    }
    return {
      kind: 'error',
      error: RequestError.internalError(undefined, String(error)).toErrorResponse(),
    };
  }
}

async function readTextFile(
  params: ReadTextFileRequest | undefined,
  ctx: HandlerContext,
): Promise<HandlerOutcome> {
  const pathCheck = checkPath(params?.path, ctx);
  if ('error' in pathCheck) return { kind: 'error', error: pathCheck.error };

  let content: string;
  try {
    content = await readFile(pathCheck.path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      kind: 'error',
      error:
        code === 'ENOENT'
          ? RequestError.resourceNotFound(pathCheck.path).toErrorResponse()
          : RequestError.internalError(undefined, String(error)).toErrorResponse(),
    };
  }

  const startLine = optionalPositiveInt(params?.line);
  const limit = optionalPositiveInt(params?.limit);
  if (startLine === undefined && limit === undefined) {
    const response: ReadTextFileResponse = { content };
    return { kind: 'result', result: response };
  }

  // `line` is 1-based per the schema.
  const lines = content.split('\n');
  const from = startLine === undefined ? 0 : Math.max(0, startLine - 1);
  const slice = limit === undefined ? lines.slice(from) : lines.slice(from, from + limit);
  const response: ReadTextFileResponse = { content: slice.join('\n') };
  return { kind: 'result', result: response };
}

async function writeTextFile(
  params: WriteTextFileRequest | undefined,
  ctx: HandlerContext,
): Promise<HandlerOutcome> {
  const pathCheck = checkPath(params?.path, ctx);
  if ('error' in pathCheck) return { kind: 'error', error: pathCheck.error };

  if (typeof params?.content !== 'string') {
    return {
      kind: 'error',
      error: RequestError.invalidParams(undefined, 'content must be a string').toErrorResponse(),
    };
  }

  try {
    await writeFile(pathCheck.path, params.content, 'utf8');
  } catch (error) {
    return {
      kind: 'error',
      error: RequestError.internalError(undefined, String(error)).toErrorResponse(),
    };
  }
  const response: WriteTextFileResponse = {};
  return { kind: 'result', result: response };
}

type PathCheck = { path: string } | { error: ErrorResponse };

/**
 * ACP requires absolute paths. We additionally confine access to the session
 * roots so a debugging session cannot be talked into reading `~/.ssh` by an
 * agent under development.
 */
function checkPath(value: unknown, ctx: HandlerContext): PathCheck {
  if (typeof value !== 'string' || value.length === 0) {
    return {
      error: RequestError.invalidParams(
        undefined,
        'path must be a non-empty string',
      ).toErrorResponse(),
    };
  }
  if (!isAbsolute(value)) {
    return {
      error: RequestError.invalidParams(
        { path: value },
        `path must be absolute: ${value}`,
      ).toErrorResponse(),
    };
  }

  const resolved = resolve(value);
  const inRoot = ctx.allowedRoots.some((root) => {
    const rel = relative(resolve(root), resolved);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });

  if (!inRoot) {
    return {
      error: RequestError.invalidParams(
        { allowedRoots: ctx.allowedRoots },
        `path is outside the session roots: ${resolved}`,
      ).toErrorResponse(),
    };
  }
  return { path: resolved };
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}
