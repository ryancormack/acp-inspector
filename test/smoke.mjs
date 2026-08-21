#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Boots the real CLI, connects to the real control socket, drives a full
 * initialize -> session/new -> session/prompt turn against the stub agent, and
 * asserts on what the inspector captured. No mocks: if this passes, the tool
 * works.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const stubAgent = fileURLToPath(new URL('./fixtures/stub-agent.mjs', import.meta.url));
const PORT = 6399;

const failures = [];
const check = (label, condition, detail = '') => {
  const mark = condition ? 'ok  ' : 'FAIL';
  if (!condition) failures.push(label);
  process.stdout.write(`${mark} ${label}${detail ? ` -- ${detail}` : ''}\n`);
};

const cli = spawn(
  process.execPath,
  ['dist/server/cli.js', '--port', String(PORT), '--no-open', '--', process.execPath, stubAgent],
  { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
);

cli.stderr.on('data', (chunk) => process.stderr.write(`[cli] ${chunk}`));

const url = await new Promise((resolve, reject) => {
  let buffer = '';
  const timer = setTimeout(() => reject(new Error('CLI never printed a URL')), 10_000);
  cli.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/);
    if (match) {
      clearTimeout(timer);
      resolve(match[0]);
    }
  });
});

const token = new URL(url).searchParams.get('token');

// Guard 1: the token is required.
await check(
  'websocket without a token is rejected',
  await expectRejected(`ws://127.0.0.1:${PORT}/ws`),
);

// Guard 2: a foreign Origin is rejected even with a valid token.
await check(
  'websocket from a foreign Origin is rejected',
  await expectRejected(`ws://127.0.0.1:${PORT}/ws?token=${token}`, {
    origin: 'http://evil.example',
  }),
);

const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
const entries = [];
let state = null;
let answeredPermission = false;

socket.on('message', (data) => {
  const event = JSON.parse(String(data));
  if (event.type === 'hello') {
    state = event.state;
    entries.push(...event.log);
  }
  if (event.type === 'state') state = event.state;
  if (event.type === 'log') entries.push(...event.entries);
  if (event.type === 'notice') process.stdout.write(`[notice:${event.level}] ${event.text}\n`);

  // Answer the permission request the moment it is deferred to us.
  const waiting = state?.pending?.find((p) => p.method === 'session/request_permission');
  if (waiting && !answeredPermission) {
    answeredPermission = true;
    send({
      type: 'respond',
      id: waiting.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
  }
});

const send = (command) => socket.send(JSON.stringify(command));

await new Promise((resolve) => socket.once('open', resolve));

send({ type: 'launch' });
await settle(400);

send({
  type: 'send',
  assignId: true,
  message: {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
        auth: { terminal: false },
      },
      clientInfo: { name: 'smoke', version: '0' },
    },
  },
});
await settle(300);

send({
  type: 'send',
  assignId: true,
  message: { jsonrpc: '2.0', method: 'session/new', params: { cwd: repoRoot, mcpServers: [] } },
});
await settle(300);

send({
  type: 'send',
  assignId: true,
  message: {
    jsonrpc: '2.0',
    method: 'session/prompt',
    params: { sessionId: state?.sessionId, prompt: [{ type: 'text', text: 'go' }] },
  },
});
await settle(1500);

// A deliberately invalid frame: params are wrong for the method.
send({
  type: 'send',
  assignId: true,
  message: { jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 42 } },
});
await settle(400);

// Structurally valid per the schema (SessionId is a bare string) but wrong: a
// session-scoped call made before session/new returned.
send({
  type: 'send',
  assignId: true,
  message: {
    jsonrpc: '2.0',
    method: 'session/prompt',
    params: { sessionId: '', prompt: [{ type: 'text', text: 'no session yet' }] },
  },
});
await settle(400);

/* ------------------------------------------------- cancellation scenario */

// Second turn, this time cancelled at the permission gate instead of answered.
const framesBeforeCancel = entries.length;
answeredPermission = true; // stop the auto-answer above from racing the cancel
send({
  type: 'send',
  assignId: true,
  message: {
    jsonrpc: '2.0',
    method: 'session/prompt',
    params: { sessionId: state?.sessionId, prompt: [{ type: 'text', text: 'cancel this' }] },
  },
});
await settle(900);

const promptsInFlight = state?.activePrompts ?? 0;
const permissionOpen =
  state?.pending?.some((p) => p.method === 'session/request_permission') ?? false;

send({ type: 'cancelTurn' });
await settle(1200);

const cancelFrames = entries.slice(framesBeforeCancel);

/* ----------------------------------------------------------------- assertions */

const byMethod = (method, dir) =>
  entries.filter((entry) => entry.method === method && (dir ? entry.dir === dir : true));

check('negotiated protocol version recorded', state?.negotiated?.protocolVersion === 1);
check('agentInfo captured', state?.negotiated?.agentInfo?.name === 'stub-agent');
check('sessionId captured from session/new', state?.sessionId === 'sess-stub-1');

check('initialize round trip logged both ways', byMethod('initialize', 'out').length === 1);
const initResponse = entries.find(
  (entry) => entry.dir === 'in' && entry.kind === 'response' && entry.durationMs !== undefined,
);
check('response correlated to its request with a duration', initResponse !== undefined,
  initResponse ? `${initResponse.durationMs}ms` : '');

check('session/update notifications captured', byMethod('session/update', 'in').length >= 2);
check('agent stderr captured', entries.some((entry) => entry.dir === 'stderr'));

const malformed = entries.filter((entry) => entry.kind === 'malformed');
check('stray stdout text flagged as malformed', malformed.length >= 1,
  `${malformed.length} frame(s)`);
check(
  'malformed frame explains the ACP rule',
  malformed[0]?.violations?.some((v) => v.includes('non-ACP stdout')) === true,
);

check('fs/read_text_file was serviced', byMethod('fs/read_text_file', 'in').length >= 1);
const readResponse = entries.find(
  (entry) => entry.dir === 'out' && entry.kind === 'response' && entry.raw.includes('content'),
);
check('inspector answered the file read', readResponse !== undefined);

const terminalReject = entries.find(
  (entry) => entry.dir === 'out' && entry.kind === 'error' && entry.raw.includes('did not advertise'),
);
check('terminal/create rejected because the capability was not advertised', terminalReject !== undefined);

const permissionAnswer = entries.find(
  (entry) => entry.dir === 'out' && entry.raw.includes('allow-once'),
);
check('permission request was deferred and answered from the UI', permissionAnswer !== undefined);

const promptDone = entries.find(
  (entry) => entry.dir === 'in' && entry.raw.includes('end_turn'),
);
check('prompt turn completed with a stop reason', promptDone !== undefined);

const schemaFlagged = entries.filter(
  (entry) =>
    entry.dir === 'out' &&
    entry.method === 'session/prompt' &&
    entry.violations?.some((v) => v.includes('must be string')),
);
check('schema validation flagged the wrongly-typed sessionId', schemaFlagged.length === 1,
  schemaFlagged[0]?.violations?.join('; ') ?? '');

check('valid frames were not flagged', byMethod('initialize', 'out')[0]?.violations === undefined);

/* ------------------------------------------------- session scope */

const emptySession = entries.find(
  (entry) => entry.dir === 'out' && entry.raw.includes('"sessionId":""'),
);
check('the empty-sessionId call was captured', emptySession !== undefined);
check(
  'an empty sessionId is flagged even though the schema accepts it',
  emptySession?.violations?.some((v) => v.includes('empty sessionId')) === true,
  emptySession?.violations?.join('; ') ?? 'no violations',
);

/* ------------------------------------------------- vendor extensions */
const extFrames = entries.filter((entry) => entry.extension === true);
check('vendor extension frames are flagged as extensions', extFrames.length >= 2,
  `${extFrames.length} frames`);
check(
  'the extension method is recorded in state',
  state?.extensions?.some((ext) => ext.method === '_stub.dev/metadata') === true,
);
const extRecord = state?.extensions?.find((ext) => ext.method === '_stub.dev/metadata');
check('repeat use is counted, not re-announced', (extRecord?.count ?? 0) >= 2,
  `count=${String(extRecord?.count)}`);
check('it is recorded as a notification', extRecord?.kind === 'notification');
const extNotes = entries.filter(
  (entry) => entry.kind === 'meta' && entry.raw.includes('vendor extension'),
);
check('announced exactly once per method', extNotes.length === 1, `${extNotes.length} notes`);
check(
  'no complaint per extension frame',
  !entries.some((entry) => entry.raw.includes('ignoring unhandled notification _stub.dev')),
);

/* ------------------------------------------------- tool call payloads */

const toolUpdates = entries.filter(
  (entry) => entry.dir === 'in' && entry.raw.includes('"toolCallId":"tc-1"'),
);
check('tool call and its update were captured', toolUpdates.length >= 2,
  `${toolUpdates.length} frames`);
check(
  'tool call carried rawInput and locations',
  toolUpdates.some((e) => e.raw.includes('rawInput') && e.raw.includes('locations')),
);
check(
  'tool update carried a diff and rawOutput',
  toolUpdates.some((e) => e.raw.includes('"type":"diff"') && e.raw.includes('rawOutput')),
);

/* ------------------------------------------------- cancellation */

check('a prompt turn was tracked as in flight', promptsInFlight >= 1, `${promptsInFlight}`);
check('the permission gate was open before cancelling', permissionOpen);

check(
  'session/cancel was sent',
  cancelFrames.some((e) => e.dir === 'out' && e.method === 'session/cancel'),
);
check(
  'the pending permission was answered with the cancelled outcome',
  cancelFrames.some((e) => e.dir === 'out' && e.raw.includes('"outcome":"cancelled"')),
);
check(
  'the inspector noted answering it, as cancellation requires',
  cancelFrames.some((e) => e.kind === 'meta' && e.raw.includes('cancelled outcome')),
);
check(
  'the agent settled the turn with stopReason cancelled',
  cancelFrames.some((e) => e.dir === 'in' && e.raw.includes('"stopReason":"cancelled"')),
);
check(
  'a correctly cancelled turn was not flagged as a violation',
  !cancelFrames.some((e) => e.kind === 'meta' && e.raw.includes('ACP requires "cancelled"')),
);
check('no prompt left in flight after cancelling', (state?.activePrompts ?? -1) === 0,
  `activePrompts=${String(state?.activePrompts)}`);

socket.close();
cli.kill('SIGTERM');
await settle(300);

process.stdout.write(
  failures.length === 0
    ? `\nall ${'' + (entries.length)} frames captured, every check passed\n`
    : `\n${failures.length} check(s) failed: ${failures.join(', ')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);

/* --------------------------------------------------------------------- helpers */

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectRejected(target, options = {}) {
  return new Promise((resolve) => {
    const probe = new WebSocket(target, options);
    probe.on('open', () => {
      probe.close();
      resolve(false);
    });
    probe.on('error', () => resolve(true));
  });
}
