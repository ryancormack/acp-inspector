import { AGENT_METHODS, PROTOCOL_METHODS, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { CapabilityToggles } from '../shared/wire';

export { PROTOCOL_VERSION };

export interface TemplateContext {
  protocolVersion: number;
  capabilities: CapabilityToggles;
  cwd: string;
  sessionId: string | null;
}

/**
 * Builds the `clientCapabilities` object from the UI toggles.
 *
 * Absent keys are meaningful in ACP: omitting `elicitation` entirely is how a
 * client says it does not support elicitation, which is not the same as sending
 * an empty object.
 */
export function clientCapabilities(toggles: CapabilityToggles): Record<string, unknown> {
  return {
    fs: { readTextFile: toggles.fsRead, writeTextFile: toggles.fsWrite },
    terminal: toggles.terminal,
    auth: { terminal: toggles.authTerminal },
    ...(toggles.elicitation ? { elicitation: { form: {}, url: {} } } : {}),
  };
}

/** Methods that carry no id and get no response. */
const NOTIFICATIONS = new Set<string>([
  AGENT_METHODS.session_cancel,
  AGENT_METHODS.document_did_open,
  AGENT_METHODS.document_did_change,
  AGENT_METHODS.document_did_close,
  AGENT_METHODS.document_did_save,
  AGENT_METHODS.document_did_focus,
  PROTOCOL_METHODS.cancel_request,
]);

type ParamsFactory = (ctx: TemplateContext) => unknown;

/**
 * Starting params for the methods a debugging session actually types.
 *
 * Every method in the SDK's registry is selectable; the ones without an entry
 * here just start from `{}`. Curating the common flow rather than all 29 keeps
 * the dropdown honest without pretending to know the shape of, say,
 * `nes/suggest`.
 */
const CURATED: Record<string, ParamsFactory> = {
  [AGENT_METHODS.initialize]: (ctx) => ({
    protocolVersion: ctx.protocolVersion,
    clientCapabilities: clientCapabilities(ctx.capabilities),
    clientInfo: { name: 'acp-debugger', version: '0.0.1' },
  }),
  [AGENT_METHODS.authenticate]: () => ({ methodId: '' }),
  [AGENT_METHODS.session_new]: (ctx) => ({ cwd: ctx.cwd, mcpServers: [] }),
  [AGENT_METHODS.session_prompt]: (ctx) => ({
    sessionId: ctx.sessionId ?? '',
    prompt: [{ type: 'text', text: 'Hello' }],
  }),
  [AGENT_METHODS.session_cancel]: (ctx) => ({ sessionId: ctx.sessionId ?? '' }),
  [AGENT_METHODS.session_list]: () => ({}),
  [AGENT_METHODS.session_load]: (ctx) => ({
    sessionId: ctx.sessionId ?? '',
    cwd: ctx.cwd,
    mcpServers: [],
  }),
  [AGENT_METHODS.session_resume]: (ctx) => ({
    sessionId: ctx.sessionId ?? '',
    cwd: ctx.cwd,
    mcpServers: [],
  }),
  [AGENT_METHODS.session_fork]: (ctx) => ({ sessionId: ctx.sessionId ?? '', cwd: ctx.cwd }),
  [AGENT_METHODS.session_set_mode]: (ctx) => ({ sessionId: ctx.sessionId ?? '', modeId: '' }),
  [AGENT_METHODS.session_set_config_option]: (ctx) => ({
    sessionId: ctx.sessionId ?? '',
    configId: '',
    value: '',
  }),
  [AGENT_METHODS.session_close]: (ctx) => ({ sessionId: ctx.sessionId ?? '' }),
  [AGENT_METHODS.session_delete]: (ctx) => ({ sessionId: ctx.sessionId ?? '' }),
  [AGENT_METHODS.logout]: () => ({}),
  [AGENT_METHODS.providers_list]: () => ({}),
  [PROTOCOL_METHODS.cancel_request]: () => ({ requestId: 1 }),
};

/**
 * Every method the client may send, taken from the SDK so it cannot drift.
 * Curated ones first, in the order a session uses them.
 */
export const ALL_METHODS: string[] = (() => {
  const curated = Object.keys(CURATED);
  const rest = [...Object.values(AGENT_METHODS), PROTOCOL_METHODS.cancel_request]
    .filter((method) => !curated.includes(method))
    .sort();
  return [...curated, ...rest];
})();

export interface Template {
  method: string;
  notification: boolean;
  curated: boolean;
  params: ParamsFactory;
}

export function templateFor(method: string): Template {
  const factory = CURATED[method];
  return {
    method,
    notification: NOTIFICATIONS.has(method),
    curated: factory !== undefined,
    params: factory ?? (() => ({})),
  };
}
