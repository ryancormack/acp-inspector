import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collapseUpdates } from '../dist/shared/transcript.js';

let seq = 0;

/** A `session/update` frame carrying one update payload. */
const upd = (update) => {
  seq += 1;
  const msg = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's1', update },
  };
  return {
    seq,
    ts: 1000 + seq,
    dir: 'in',
    kind: 'notification',
    raw: JSON.stringify(msg),
    msg,
    method: 'session/update',
  };
};

/** Any other frame, e.g. a request the agent sent us. */
const other = (method) => {
  seq += 1;
  const msg = { jsonrpc: '2.0', id: seq, method, params: {} };
  return {
    seq,
    ts: 1000 + seq,
    dir: 'in',
    kind: 'request',
    raw: JSON.stringify(msg),
    msg,
    method,
  };
};

const chunk = (text, messageId, kind = 'agent_message_chunk') =>
  upd({
    sessionUpdate: kind,
    ...(messageId === undefined ? {} : { messageId }),
    content: { type: 'text', text },
  });

const groups = (rows) => rows.filter((r) => r.type === 'group').map((r) => r.group);

test('chunks sharing a messageId join into one row', () => {
  seq = 0;
  const rows = collapseUpdates([
    chunk('Hello', 'm1'),
    chunk(', ', 'm1'),
    chunk('world', 'm1'),
  ]);

  assert.equal(rows.length, 1);
  const [g] = groups(rows);
  assert.equal(g.text, 'Hello, world');
  assert.equal(g.count, 3);
  assert.equal(g.role, 'agent');
  assert.equal(g.label, 'agent message');
  assert.deepEqual(g.seqs, [1, 2, 3]);
  assert.equal(g.firstSeq, 1);
  assert.equal(g.lastSeq, 3);
});

test('a group is placed at its first frame even when interleaved', () => {
  seq = 0;
  const rows = collapseUpdates([
    chunk('before ', 'm1'),
    upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', status: 'pending' }),
    chunk('after', 'm1'),
  ]);

  // Two rows: the message group (first) and the tool group.
  assert.equal(rows.length, 2);
  assert.equal(rows[0].group.role, 'agent');
  assert.equal(rows[0].group.text, 'before after');
  assert.equal(rows[1].group.role, 'tool');
});

test('chunks without a messageId merge consecutively', () => {
  seq = 0;
  const rows = collapseUpdates([chunk('a'), chunk('b'), chunk('c')]);
  assert.equal(rows.length, 1);
  assert.equal(groups(rows)[0].text, 'abc');
});

test('a non-update frame closes an anonymous chunk run', () => {
  seq = 0;
  const rows = collapseUpdates([
    chunk('first'),
    other('fs/read_text_file'),
    chunk('second'),
  ]);

  assert.equal(rows.length, 3);
  assert.equal(rows[0].group.text, 'first');
  assert.equal(rows[1].type, 'frame');
  assert.equal(rows[1].entry.method, 'fs/read_text_file');
  assert.equal(rows[2].group.text, 'second');
});

test('thoughts and user messages are separate roles from agent output', () => {
  seq = 0;
  const rows = collapseUpdates([
    chunk('thinking', 'm1', 'agent_thought_chunk'),
    chunk('answer', 'm1', 'agent_message_chunk'),
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(
    groups(rows).map((g) => [g.role, g.text]),
    [
      ['agent_thought', 'thinking'],
      ['agent', 'answer'],
    ],
  );
});

test('a tool call and its updates collapse to one row with the final status', () => {
  seq = 0;
  const rows = collapseUpdates([
    upd({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Write answer.md',
      kind: 'edit',
      status: 'pending',
    }),
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }),
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
  ]);

  assert.equal(rows.length, 1);
  const [g] = groups(rows);
  assert.equal(g.count, 3);
  assert.equal(g.text, 'Write answer.md');
  assert.equal(g.toolStatus, 'completed');
  assert.equal(g.toolKind, 'edit');
  assert.equal(g.toolCallId, 't1');
});

test('two different tool calls stay separate', () => {
  seq = 0;
  const rows = collapseUpdates([
    upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'One', status: 'pending' }),
    upd({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Two', status: 'pending' }),
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(groups(rows).map((g) => g.text), ['One', 'Two']);
  assert.equal(groups(rows)[0].toolStatus, 'completed');
  assert.equal(groups(rows)[1].toolStatus, 'pending');
});

test('snapshot updates collapse to the latest value', () => {
  seq = 0;
  const rows = collapseUpdates([
    upd({ sessionUpdate: 'usage_update', used: 10, size: 1000 }),
    upd({ sessionUpdate: 'usage_update', used: 250, size: 1000 }),
  ]);

  assert.equal(rows.length, 1);
  const [g] = groups(rows);
  assert.equal(g.count, 2);
  assert.match(g.text, /250\/1000 tokens/);
});

test('plan updates summarise their entry statuses', () => {
  seq = 0;
  const rows = collapseUpdates([
    upd({
      sessionUpdate: 'plan',
      entries: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' },
        { content: 'c', status: 'pending' },
      ],
    }),
  ]);

  const [g] = groups(rows);
  assert.match(g.text, /3 entries/);
  assert.match(g.text, /1 completed/);
  assert.match(g.text, /2 pending/);
});

test('non-text content is recorded as an attachment, not dropped', () => {
  seq = 0;
  const rows = collapseUpdates([
    chunk('look: ', 'm1'),
    upd({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    }),
  ]);

  const [g] = groups(rows);
  assert.equal(g.text, 'look: ');
  assert.deepEqual(g.attachments, ['image image/png']);
});

test('an unrecognised sessionUpdate stays an individual frame', () => {
  seq = 0;
  const rows = collapseUpdates([upd({ sessionUpdate: '_vendor_thing', payload: 1 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'frame');
});

test('a malformed session/update is passed through untouched', () => {
  seq = 0;
  const bad = upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
  delete bad.msg.params.update;
  const rows = collapseUpdates([bad]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'frame');
});

test('a tool call carries its content, raw input/output and locations', () => {
  seq = 0;
  const rows = collapseUpdates([
    upd({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Edit config',
      kind: 'edit',
      status: 'pending',
      rawInput: { path: '/tmp/a.json', value: 1 },
      locations: [{ path: '/tmp/a.json', line: 12 }, { path: '/tmp/b.json' }],
    }),
    upd({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawOutput: { ok: true },
      content: [
        { type: 'content', content: { type: 'text', text: 'wrote 1 file' } },
        { type: 'diff', path: '/tmp/a.json', oldText: '{}', newText: '{"value":1}' },
        { type: 'terminal', terminalId: 'term-9' },
      ],
    }),
  ]);

  const [g] = groups(rows);
  assert.equal(g.toolStatus, 'completed');
  assert.deepEqual(g.rawInput, { path: '/tmp/a.json', value: 1 });
  assert.deepEqual(g.rawOutput, { ok: true });
  assert.deepEqual(g.locations, [{ path: '/tmp/a.json', line: 12 }, { path: '/tmp/b.json' }]);
  assert.equal(g.toolContent.length, 3);
  assert.deepEqual(g.toolContent[0], { type: 'content', text: 'wrote 1 file' });
  assert.equal(g.toolContent[1].type, 'diff');
  assert.equal(g.toolContent[1].newText, '{"value":1}');
  assert.equal(g.toolContent[2].terminalId, 'term-9');
});

test('a later update replaces tool content rather than appending it', () => {
  seq = 0;
  const rows = collapseUpdates([
    upd({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Run',
      content: [{ type: 'content', content: { type: 'text', text: 'first' } }],
    }),
    upd({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      content: [{ type: 'content', content: { type: 'text', text: 'second' } }],
    }),
  ]);

  const [g] = groups(rows);
  assert.equal(g.toolContent.length, 1);
  assert.equal(g.toolContent[0].text, 'second');
});

test('an update that omits a field leaves the earlier value intact', () => {
  seq = 0;
  const rows = collapseUpdates([
    upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', rawInput: { a: 1 } }),
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
  ]);

  const [g] = groups(rows);
  assert.deepEqual(g.rawInput, { a: 1 });
  assert.equal(g.toolStatus, 'completed');
});

test('a non-text tool content block is described rather than dropped', () => {
  seq = 0;
  const rows = collapseUpdates([
    upd({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Screenshot',
      content: [
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'AA' } },
        { type: '_vendor' },
      ],
    }),
  ]);

  const [g] = groups(rows);
  assert.deepEqual(g.toolContent[0], { type: 'content', attachment: 'image image/png' });
  assert.equal(g.toolContent[1].type, '_vendor');
});

test('row order matches the incoming frame order', () => {
  seq = 0;
  const rows = collapseUpdates([
    other('initialize'),
    chunk('hi', 'm1'),
    other('fs/read_text_file'),
    chunk('bye', 'm2'),
  ]);

  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4]);
});
