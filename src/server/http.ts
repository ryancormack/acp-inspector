import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientCommand, ServerEvent } from '../shared/wire.js';
import type { InspectorSession } from './session.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface HttpServerOptions {
  port: number;
  /** Always a loopback address. The CLI refuses anything else. */
  host: string;
  token: string;
  uiDir: string;
  session: InspectorSession;
  /** Extra origins to accept, e.g. the Vite dev server during development. */
  extraOrigins: string[];
}

/**
 * The inspector's control plane.
 *
 * This process can spawn arbitrary commands, so the transport is locked down
 * rather than merely tidy. MCP Inspector shipped CVE-2025-49596 because a
 * localhost server with no auth and no origin check is reachable from any page
 * the developer happens to have open, via DNS rebinding. Three guards apply to
 * every request: a loopback bind, a `Host` header that must itself be loopback,
 * and a token that must match.
 */
export function startHttpServer(options: HttpServerOptions): Server {
  const { port, host, token, uiDir, session, extraOrigins } = options;

  const allowedOrigins = new Set<string>([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
    ...extraOrigins,
  ]);

  const server = createServer((req, res) => {
    if (!hasLoopbackHost(req)) {
      respondText(res, 403, 'refused: Host header is not loopback');
      return;
    }
    void serveStatic(req, res, uiDir);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    const reject = (code: number, reason: string): void => {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    if (!hasLoopbackHost(req)) return reject(403, 'Forbidden');

    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return reject(403, 'Forbidden');
    }
    if (!tokenMatches(url.searchParams.get('token'), token)) {
      return reject(401, 'Unauthorized');
    }

    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, session));
  });

  server.listen(port, host);
  return server;
}

function attach(ws: WebSocket, session: InspectorSession): void {
  const send = (event: ServerEvent): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  const unsubscribe = session.subscribe(send);

  ws.on('message', (data) => {
    let command: ClientCommand;
    try {
      command = JSON.parse(String(data)) as ClientCommand;
    } catch (error) {
      send({ type: 'notice', level: 'error', text: `unparseable command: ${String(error)}` });
      return;
    }

    try {
      applyCommand(command, session);
    } catch (error) {
      send({ type: 'notice', level: 'error', text: (error as Error).message });
    }
  });

  ws.on('close', unsubscribe);
  ws.on('error', unsubscribe);
}

function applyCommand(command: ClientCommand, session: InspectorSession): void {
  switch (command.type) {
    case 'launch':
      session.launch({
        ...(command.command !== undefined ? { command: command.command } : {}),
        ...(command.args !== undefined ? { args: command.args } : {}),
        ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
        ...(command.env !== undefined ? { env: command.env } : {}),
      });
      return;
    case 'kill':
      session.kill();
      return;
    case 'send':
      session.send(command.message, command.assignId ?? false);
      return;
    case 'respond':
      session.respond(command.id, command.result, command.error);
      return;
    case 'capabilities':
      session.setCapabilities(command.capabilities);
      return;
    case 'protocolVersion':
      session.setProtocolVersion(command.version);
      return;
    case 'clear':
      session.clear();
      return;
    default: {
      const unknown = command as { type?: string };
      throw new Error(`unknown command ${String(unknown.type)}`);
    }
  }
}

/**
 * Rejects a request whose `Host` is a name that merely resolves to loopback.
 * This is the DNS-rebinding guard: the attacker controls DNS, not this header.
 */
function hasLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (host === undefined) return false;
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : (host.split(':')[0] ?? '');
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function tokenMatches(supplied: string | null, expected: string): boolean {
  if (supplied === null) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  uiDir: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;

  const root = resolve(uiDir);
  const candidate = resolve(join(root, normalize(decodeURIComponent(requested))));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    respondText(res, 403, 'forbidden');
    return;
  }

  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(candidate)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      // The UI talks only to its own origin; nothing here needs to be framed.
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    createReadStream(candidate).pipe(res);
  } catch {
    respondText(
      res,
      404,
      'not found. Has the UI been built? Run `npm run build:ui` in the acp-debugger checkout.',
    );
  }
}

function respondText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}
