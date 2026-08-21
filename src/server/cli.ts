#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { AgentLaunchSpec } from './agent-process.js';
import { startHttpServer } from './http.js';
import { InspectorSession } from './session.js';
import { checkValidatorTable } from './validate.js';

const DEFAULT_PORT = 6274;
/** Bound to loopback unconditionally: this process can spawn commands. */
const HOST = '127.0.0.1';

interface CliOptions {
  port: number;
  cwd: string;
  open: boolean;
  allowBrowserSpawn: boolean;
  dev: boolean;
  env: Record<string, string>;
  agent: { command: string; args: string[] } | null;
}

const USAGE = `
acp-debugger - browser-based inspector for the Agent Client Protocol

Usage:
  acp-debugger [options] -- <agent-command> [agent-args...]

Options:
  --port <n>              Port to serve the UI on (default ${DEFAULT_PORT})
  --cwd <path>            Working directory for the agent and the ACP session
                          (default: the current directory)
  --env KEY=VALUE         Extra environment variable for the agent (repeatable)
  --allow-browser-spawn   Permit editing the agent command from the browser.
                          Off by default: the command comes from this argv.
  --no-open               Do not open a browser automatically
  --dev                   Also accept websocket connections from the Vite dev
                          server on port 6275
  -h, --help              Show this help

Examples:
  acp-debugger -- node dist/acp-agent.cjs
  acp-debugger --cwd ~/code/my-project -- uv run my-acp-agent
  acp-debugger --env AWS_PROFILE=dev -- node dist/acp-agent.cjs
`.trimStart();

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    port: DEFAULT_PORT,
    cwd: process.cwd(),
    open: true,
    allowBrowserSpawn: false,
    dev: false,
    env: {},
    agent: null,
  };

  const separator = argv.indexOf('--');
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const agentArgv = separator === -1 ? [] : argv.slice(separator + 1);

  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    switch (flag) {
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case '--port': {
        const value = Number(flags[++i]);
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
          fail(`--port needs a port number, got ${String(flags[i])}`);
        }
        options.port = value;
        break;
      }
      case '--cwd':
        options.cwd = resolve(requireValue(flags[++i], '--cwd'));
        break;
      case '--env': {
        const pair = requireValue(flags[++i], '--env');
        const eq = pair.indexOf('=');
        if (eq <= 0) fail(`--env expects KEY=VALUE, got ${pair}`);
        options.env[pair.slice(0, eq)] = pair.slice(eq + 1);
        break;
      }
      case '--allow-browser-spawn':
        options.allowBrowserSpawn = true;
        break;
      case '--no-open':
        options.open = false;
        break;
      case '--dev':
        options.dev = true;
        break;
      default:
        fail(`unknown option ${String(flag)}\n\n${USAGE}`);
    }
  }

  const [command, ...args] = agentArgv;
  if (command !== undefined) options.agent = { command, args };

  return options;
}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined) fail(`${flag} needs a value`);
  return value;
}

function fail(message: string): never {
  process.stderr.write(`acp-debugger: ${message}\n`);
  process.exit(1);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  // Fail loudly if the schema moved under us, rather than silently validating
  // nothing.
  const brokenValidators = checkValidatorTable();
  if (brokenValidators.length > 0) {
    process.stderr.write(
      `acp-debugger: warning, ${brokenValidators.length} schema mapping(s) no longer resolve; ` +
        `those methods will not be validated:\n  ${brokenValidators.join('\n  ')}\n`,
    );
  }
  const token = randomBytes(24).toString('hex');

  const launchSpec: AgentLaunchSpec | null = options.agent
    ? {
        command: options.agent.command,
        args: options.agent.args,
        cwd: options.cwd,
        env: options.env,
      }
    : null;

  const session = new InspectorSession({
    launchSpec,
    allowBrowserSpawn: options.allowBrowserSpawn,
    defaultCwd: options.cwd,
  });

  const uiDir = fileURLToPath(new URL('../ui/', import.meta.url));
  const extraOrigins = options.dev
    ? ['http://127.0.0.1:6275', 'http://localhost:6275']
    : [];

  const server = startHttpServer({
    port: options.port,
    host: HOST,
    token,
    uiDir,
    session,
    extraOrigins,
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      fail(`port ${options.port} is already in use; pass --port to pick another`);
    }
    fail(String(error));
  });

  server.on('listening', () => {
    const url = `http://${HOST}:${options.port}/?token=${token}`;
    process.stdout.write(`\nACP debugger listening on ${url}\n`);
    if (launchSpec) {
      process.stdout.write(
        `Agent: ${launchSpec.command} ${launchSpec.args.join(' ')}\n` +
          `cwd:   ${launchSpec.cwd}\n`,
      );
    } else {
      process.stdout.write(
        'No agent command given. Pass one after `--`, e.g.\n' +
          '  acp-debugger -- node dist/acp-agent.cjs\n',
      );
    }
    process.stdout.write('\nPress Ctrl-C to stop.\n\n');
    if (options.open) openBrowser(url);
  });

  const shutdown = (): void => {
    session.kill();
    server.close(() => process.exit(0));
    // Do not wait forever on a wedged agent.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function openBrowser(url: string): void {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    // The URL carries the session token, so it is passed as a single argv entry
    // rather than through a shell.
    spawn(opener, [url], { stdio: 'ignore', detached: true, shell: false }).unref();
  } catch {
    // Opening a browser is a convenience; the URL is on stdout regardless.
  }
}

main();
