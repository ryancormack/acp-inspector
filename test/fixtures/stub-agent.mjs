#!/usr/bin/env node
/**
 * A deliberately imperfect ACP agent, used to prove the inspector surfaces the
 * things that matter:
 *
 *  - it streams `session/update` notifications
 *  - it calls back into the client (`fs/read_text_file`)
 *  - it gates a tool call behind `session/request_permission`
 *  - it calls `terminal/create`, which the inspector rejects unless the
 *    terminal capability is advertised
 *  - it writes one line of plain text to stdout, which ACP forbids
 *  - it logs to stderr, which ACP allows
 */
import { createInterface } from 'node:readline';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const pending = new Map();
let nextId = 1000;

const waitFor = (id) => new Promise((resolve) => pending.set(id, resolve));

const call = async (method, params) => {
  const id = nextId++;
  const answer = waitFor(id);
  send({ jsonrpc: '2.0', id, method, params });
  return answer;
};

process.stderr.write('stub-agent: ready\n');

createInterface({ input: process.stdin }).on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`stub-agent: unparseable input ${line}\n`);
    return;
  }

  if (message.id !== undefined && ('result' in message || 'error' in message)) {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
    return;
  }

  switch (message.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          agentInfo: { name: 'stub-agent', version: '0.0.1' },
          authMethods: [],
        },
      });
      return;

    case 'session/new':
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess-stub-1' } });
      return;

    case 'session/prompt': {
      const { sessionId } = message.params;

      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'working on it' },
          },
        },
      });

      // Forbidden: stdout must carry ACP messages only.
      process.stdout.write('stub-agent: oops, a stray console.log\n');

      const read = await call('fs/read_text_file', {
        sessionId,
        path: `${process.cwd()}/package.json`,
        line: 1,
        limit: 2,
      });
      process.stderr.write(`stub-agent: read returned ${'result' in read ? 'ok' : 'error'}\n`);

      const permission = await call('session/request_permission', {
        sessionId,
        toolCall: {
          toolCallId: 'tc-1',
          title: 'Write src/generated.ts',
          kind: 'edit',
          status: 'pending',
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });

      const terminal = await call('terminal/create', {
        sessionId,
        command: 'echo',
        args: ['hello'],
      });
      process.stderr.write(
        `stub-agent: terminal/create -> ${'error' in terminal ? terminal.error.code : 'ok'}\n`,
      );

      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `permission: ${JSON.stringify(permission.result)}` },
          },
        },
      });

      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      return;
    }

    default:
      if (message.id !== undefined) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `stub-agent does not implement ${message.method}` },
        });
      }
  }
});
