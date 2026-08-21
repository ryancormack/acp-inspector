# acp-debugger

A browser-based inspector for the [Agent Client Protocol](https://agentclientprotocol.com).
Launches your ACP agent over stdio, acts as a real ACP **client**, and shows every
JSON-RPC message in both directions along with the agent's stderr.

```bash
npx @ryancormack/acp-debugger -- node dist/acp-agent.cjs
```

That prints a `http://127.0.0.1:6274/?token=...` URL and opens it. Press **Launch**,
then **initialize + session/new**, then send a `session/prompt`.

For an agent that needs credentials or config, pass them with `--env`. They go into
the agent's environment when it is spawned, which a shell prefix on the inspector's
own command line would not do:

```bash
acp-debugger \
  --cwd ~/code/my-project \
  --env AWS_PROFILE=my-profile \
  --env AWS_REGION=us-east-1 \
  -- ~/code/my-agent/packages/agent/dist/acp-agent.cjs
```

`--cwd` is both the agent's working directory and the `cwd` sent in `session/new`,
and it is the confinement root for any `fs/*` callbacks.

## Why a client, not a sniffer

In ACP the client side is load-bearing. The agent calls back into you constantly,
and `session/request_permission` is mandatory baseline: an agent that gates a tool
call behind it and never gets an answer stops dead with nothing in the log to
explain why. So the inspector implements the client half:

| Agent calls | Inspector does |
| --- | --- |
| `session/update` | logs the stream (message chunks, tool calls, plans, usage) |
| `session/request_permission` | holds it open and shows the agent's own options as buttons |
| `fs/read_text_file` / `fs/write_text_file` | performs it, confined to the session cwd |
| `terminal/*` | rejects with `-32601` unless you advertise the capability |
| `elicitation/create` | holds it open for a manual answer |

## The capability matrix is the point

The toolbar toggles what goes into `clientCapabilities` on `initialize`. Turn
`fs.readTextFile` off, re-initialize, and watch whether your agent degrades
gracefully or falls over. Zed always says yes, so this is the path those branches
never otherwise take. Calling a method whose capability you did not advertise gets
`-32601` rather than being quietly serviced, because that is the agent's bug and
hiding it defeats the tool.

## What it catches

- **Non-JSON on stdout.** ACP says the agent MUST NOT write anything to stdout
  that is not an ACP message. A stray `console.log` is the single most common
  agent bug and it corrupts the stream for every real client. It shows up flagged.
- **Wrong params for the method**, validated against the ACP JSON Schema that ships
  inside the SDK, e.g. `params/sessionId must be string`.
- **Responses that match no outstanding request**, and requests that were never
  answered when the process exited.
- **Timings**, per request/response pair.

## Deliberately malformed traffic

The composer's method field is editable and params are free-form JSON, and the
message is serialised exactly as composed. Sending a request with a string id, a
missing `jsonrpc`, or params for a different method is a supported use, because
half of debugging an agent is seeing how it handles traffic a well-behaved editor
would never send.

## Relationship to `@agentclientprotocol/sdk`

The SDK is used for everything it can be trusted to own:

- **Types** — `shared/wire.ts` aliases `AnyMessage`, `AnyRequest`, `ErrorResponse`
  rather than redeclaring them.
- **Method registry** — `AGENT_METHODS` / `CLIENT_METHODS` / `PROTOCOL_METHODS`
  drive the composer dropdown and the capability gate table, so a method added
  upstream is not silently unreachable here. (This already paid for itself:
  `providers/*`, `nes/*`, `document/did*`, `session/fork` and `mcp/*` are in the
  registry but not in the protocol docs' method list.)
- **Error codes** — `RequestError.methodNotFound()` and friends.
- **Schema** — `@agentclientprotocol/sdk/schema/schema.json`, version-locked to the
  installed SDK.

The transport is **not** the SDK's `Connection`. Two reasons: the log needs the
bytes exactly as they crossed stdio, before any normalisation could drop an
unknown field or a malformed frame; and the inspector must be able to *send*
frames a conformant client would refuse to construct.

Two things the SDK has that would be better than what is here, but which are not
in its `exports` map and so cannot be imported without reaching past the package
contract:

- `dist/schema/zod.gen.js` — 265 generated per-type zod schemas. This is exactly
  what a validator wants. Without it, `src/server/validate.ts` carries a
  hand-written method → schema-definition table, because the shipped JSON Schema
  types `AgentRequest.method` as a bare `string` and `params` as an `anyOf` over
  every request's params, so a message-level check passes params belonging to a
  different method. The table is verified against the schema at startup and any
  unmapped method is reported as unchecked rather than as valid.
- `dist/jsonrpc.js` — `isRequestMessage` and friends, reimplemented locally in
  `session.ts`.

Both would make good upstream requests.

## Security

This process spawns commands on your machine, so the control plane is locked down
rather than merely tidy. MCP Inspector shipped CVE-2025-49596 (CVSS 9.4) because a
localhost server with no auth and no origin check is reachable from any page the
developer has open, via DNS rebinding.

- Bound to `127.0.0.1` unconditionally. There is no flag to change it.
- A random per-run token is required on the websocket handshake.
- The `Host` header must itself be loopback, which is the rebinding guard.
- `Origin`, when present, must be an origin we served.
- **The agent command comes from argv, not from the browser.** Editing it in the UI
  requires `--allow-browser-spawn`.
- `fs/*` requests are confined to the session cwd, so an agent under development
  cannot talk the inspector into reading `~/.ssh`.

## Options

```
--port <n>              Port to serve on (default 6274)
--cwd <path>            Working directory for the agent and the ACP session
--env KEY=VALUE         Extra environment variable for the agent (repeatable)
--allow-browser-spawn   Permit editing the agent command from the browser
--no-open               Do not open a browser
--dev                   Also accept websockets from the Vite dev server on 6275
-h, --help              Show usage
```

## Development

```bash
pnpm install
pnpm build          # tsc for the server, vite for the UI
pnpm test           # builds, then runs the end-to-end smoke test
pnpm typecheck
```

`pnpm test` boots the real CLI against `test/fixtures/stub-agent.mjs`, a
deliberately imperfect agent that streams updates, calls back into the client,
gates a tool call behind a permission request, calls `terminal/create` without the
capability, writes a stray line to stdout, and logs to stderr. The test drives a
full prompt turn over the real control socket and asserts on what was captured.

For UI work, run the CLI with `--dev` and `pnpm dev:ui` in parallel, then open
`http://127.0.0.1:6275/?token=<token from the CLI>` for HMR.

## Status

Working vertical slice, exercised against both the stub agent and a real
Strands-based ACP agent (full turn: capability negotiation, streamed updates, a
gated tool call answered from the UI, and the tool's side effect landing on disk).

Not exercised yet, so treat as unproven rather than working: `elicitation/create`,
`session/load` and `session/resume`, the real `fs/write_text_file` path, and the
authentication flows. Verified on macOS with Node 26 against one real agent.

Not yet built:

- **A collapsed transcript view.** A real agent streams token by token, so one
  prompt can produce a thousand `session/update` frames. The `hide session/update`
  filter keeps the log navigable, but nothing yet reassembles those chunks into the
  message the agent actually produced. This is the most useful next piece of work.
- `terminal/*` execution (currently advertised-but-unimplemented returns `-32603`)
- Tap mode: sit between a real editor and the agent to capture what Zed actually
  sends, logging over a side channel since stdout is reserved for ACP
- Export/import of a captured session
- The draft Streamable HTTP transport

There is no linter. Two `eslint-disable` comments in `src/ui` mark deliberate
`useEffect` dependency omissions but currently lint nothing.
