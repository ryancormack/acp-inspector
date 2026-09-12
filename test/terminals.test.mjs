import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { TerminalManager, TerminalError } from '../dist/server/terminals.js';

const ROOT = tmpdir();
const mk = () => new TerminalManager([ROOT]);

/** Poll output until the process exits, so the test does not race the pipe. */
async function drain(mgr, id) {
  await mgr.waitForExit(id);
  // Give the stdout 'data' listeners a tick to flush after 'exit'.
  await new Promise((r) => setTimeout(r, 20));
  return mgr.output(id);
}

test('create runs a real command and captures stdout', async () => {
  const mgr = mk();
  const { terminalId } = mgr.create({ sessionId: 's', command: 'printf', args: ['hello'] });
  assert.ok(terminalId, 'returns a terminalId');
  const out = await drain(mgr, terminalId);
  assert.equal(out.output, 'hello');
  assert.equal(out.truncated, false);
  assert.equal(out.exitStatus?.exitCode, 0);
});

test('captures interleaved stderr in the same buffer', async () => {
  const mgr = mk();
  const { terminalId } = mgr.create({
    sessionId: 's',
    command: 'sh',
    args: ['-c', 'printf out; printf err 1>&2'],
  });
  const out = await drain(mgr, terminalId);
  // Order between the two pipes is not guaranteed, but both must be present.
  assert.ok(out.output.includes('out'));
  assert.ok(out.output.includes('err'));
});

test('reports a non-zero exit code', async () => {
  const mgr = mk();
  const { terminalId } = mgr.create({ sessionId: 's', command: 'sh', args: ['-c', 'exit 3'] });
  const status = await mgr.waitForExit(terminalId);
  assert.equal(status.exitCode, 3);
});

test('outputByteLimit truncates from the front and sets truncated', async () => {
  const mgr = mk();
  const { terminalId } = mgr.create({
    sessionId: 's',
    command: 'printf',
    args: ['abcdefghij'],
    outputByteLimit: 4,
  });
  const out = await drain(mgr, terminalId);
  assert.equal(out.truncated, true);
  assert.equal(out.output, 'ghij', 'keeps the trailing bytes within the limit');
});

test('truncation lands on a UTF-8 character boundary', async () => {
  const mgr = mk();
  // Three 3-byte chars (9 bytes). A 4-byte limit would cut mid-char at byte 5;
  // the manager must advance to the next lead byte -> keep the last full char.
  const { terminalId } = mgr.create({
    sessionId: 's',
    command: 'printf',
    args: ['\u6771\u4eac\u90fd'],
    outputByteLimit: 4,
  });
  const out = await drain(mgr, terminalId);
  assert.equal(out.truncated, true);
  // Retained string must be valid (no replacement char from a split sequence).
  assert.ok(!out.output.includes('\uFFFD'), 'no broken UTF-8');
  assert.equal(out.output, '\u90fd');
});

test('injects env variables', async () => {
  const mgr = mk();
  const { terminalId } = mgr.create({
    sessionId: 's',
    command: 'sh',
    args: ['-c', 'printf %s "$INSPECTOR_TEST"'],
    env: [{ name: 'INSPECTOR_TEST', value: 'zap' }],
  });
  const out = await drain(mgr, terminalId);
  assert.equal(out.output, 'zap');
});

test('kill terminates a running process', async () => {
  const mgr = mk();
  const { terminalId } = mgr.create({ sessionId: 's', command: 'sleep', args: ['30'] });
  mgr.kill(terminalId);
  const status = await mgr.waitForExit(terminalId);
  assert.equal(status.signal, 'SIGKILL');
});

test('accepts an absolute cwd inside the roots', async () => {
  const mgr = mk();
  const { terminalId } = mgr.create({
    sessionId: 's',
    command: 'pwd',
    cwd: ROOT,
  });
  const out = await drain(mgr, terminalId);
  assert.equal(out.output.trim(), ROOT);
});

test('rejects a relative cwd with invalid-params', () => {
  const mgr = mk();
  assert.throws(
    () => mgr.create({ sessionId: 's', command: 'pwd', cwd: 'relative/dir' }),
    (e) => e instanceof TerminalError && e.kind === 'invalid-params',
  );
});

test('rejects a cwd outside the session roots', () => {
  const mgr = mk();
  assert.throws(
    () => mgr.create({ sessionId: 's', command: 'pwd', cwd: '/definitely/not/a/root' }),
    (e) => e instanceof TerminalError && e.kind === 'invalid-params',
  );
});

test('applies a default cap when outputByteLimit is omitted', async () => {
  const mgr = mk();
  // Emit ~2 MiB with no outputByteLimit; retained output must stay bounded by
  // the 1 MiB default rather than growing to the full amount.
  const { terminalId } = mgr.create({
    sessionId: 's',
    command: 'sh',
    args: ['-c', 'yes AAAAAAAA | head -c 2097152'],
  });
  const out = await drain(mgr, terminalId);
  assert.equal(out.truncated, true, 'truncation flagged once the default cap is exceeded');
  assert.ok(
    Buffer.byteLength(out.output, 'utf8') <= 1024 * 1024,
    `retained ${Buffer.byteLength(out.output, 'utf8')} bytes, expected <= 1 MiB`,
  );
});

test('a failed spawn (ENOENT) resolves wait_for_exit instead of hanging', async () => {
  const mgr = mk();
  const { terminalId } = mgr.create({
    sessionId: 's',
    command: 'this-binary-does-not-exist-xyzzy',
    args: [],
  });
  // Must settle (via 'close', since a failed spawn emits no 'exit') and not hang.
  const status = await Promise.race([
    mgr.waitForExit(terminalId).then(() => 'settled'),
    new Promise((r) => setTimeout(() => r('HUNG'), 5000)),
  ]);
  assert.equal(status, 'settled', 'wait_for_exit must resolve for a missing binary');
});

test('multi-chunk streaming truncation lands on a UTF-8 boundary (overflow==0)', async () => {
  const mgr = mk();
  // Stream 東 (e6 9d b1) then A, B one byte per chunk with limit 3. Dropping
  // whole leading chunks lands byteLength exactly on 3 with the surviving head
  // starting on a continuation byte — the overflow==0 case. Must not yield U+FFFD.
  const { terminalId } = mgr.create({
    sessionId: 's',
    command: 'sh',
    args: [
      '-c',
      // print each byte of 東AB separately so they arrive as distinct chunks
      'printf "\\346"; sleep 0.02; printf "\\235"; sleep 0.02; printf "\\261"; sleep 0.02; printf "A"; sleep 0.02; printf "B"',
    ],
    outputByteLimit: 3,
  });
  const out = await drain(mgr, terminalId);
  assert.equal(out.truncated, true);
  assert.ok(!out.output.includes('\uFFFD'), `no broken UTF-8, got ${JSON.stringify(out.output)}`);
});

test('unknown terminalId is a not-found error', () => {
  const mgr = mk();
  assert.throws(
    () => mgr.output('term-999'),
    (e) => e instanceof TerminalError && e.kind === 'not-found',
  );
});

test('releaseAll kills and forgets every terminal', async () => {
  const mgr = mk();
  const a = mgr.create({ sessionId: 's', command: 'sleep', args: ['30'] });
  const b = mgr.create({ sessionId: 's', command: 'sleep', args: ['30'] });
  mgr.releaseAll();
  assert.throws(() => mgr.output(a.terminalId), (e) => e instanceof TerminalError);
  assert.throws(() => mgr.output(b.terminalId), (e) => e instanceof TerminalError);
});
