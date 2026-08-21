import { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_METHODS } from '@agentclientprotocol/sdk';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import acpSchema from '@agentclientprotocol/sdk/schema/schema.json' with { type: 'json' };

/**
 * Validates a frame's `params` against the ACP schema that ships inside
 * `@agentclientprotocol/sdk`.
 *
 * Validating the whole message against `#/$defs/AgentRequest` looks tidier but
 * is close to worthless: in that definition `method` is only `type: "string"`
 * and `params` is an `anyOf` over every request's params, so params belonging to
 * a completely different method validate happily. The check has to be per
 * method, which needs a method -> definition map, which the schema does not
 * carry. The SDK does generate per-type zod schemas, but `dist/schema/zod.gen`
 * is absent from its `exports` map, so it cannot be imported without reaching
 * past the package contract.
 *
 * Hence the table below. Every entry is checked against the schema at startup,
 * so a rename upstream surfaces as a loud warning rather than as validation that
 * quietly stops happening, and any method without an entry is reported to the UI
 * as unchecked rather than as valid.
 */

const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  // Doc-oriented formats in the schema are not protocol requirements; a format
  // miss must not be reported as a violation.
  validateFormats: false,
});
ajv.addSchema(acpSchema as object, 'acp');

/** Method -> the `$defs` entry describing its params. */
const PARAMS_DEF: Record<string, string> = {
  // client -> agent
  [AGENT_METHODS.initialize]: 'InitializeRequest',
  [AGENT_METHODS.authenticate]: 'AuthenticateRequest',
  [AGENT_METHODS.logout]: 'LogoutRequest',
  [AGENT_METHODS.providers_list]: 'ListProvidersRequest',
  [AGENT_METHODS.providers_set]: 'SetProviderRequest',
  [AGENT_METHODS.providers_disable]: 'DisableProviderRequest',
  [AGENT_METHODS.session_new]: 'NewSessionRequest',
  [AGENT_METHODS.session_load]: 'LoadSessionRequest',
  [AGENT_METHODS.session_resume]: 'ResumeSessionRequest',
  [AGENT_METHODS.session_fork]: 'ForkSessionRequest',
  [AGENT_METHODS.session_close]: 'CloseSessionRequest',
  [AGENT_METHODS.session_delete]: 'DeleteSessionRequest',
  [AGENT_METHODS.session_list]: 'ListSessionsRequest',
  [AGENT_METHODS.session_prompt]: 'PromptRequest',
  [AGENT_METHODS.session_cancel]: 'CancelNotification',
  [AGENT_METHODS.session_set_mode]: 'SetSessionModeRequest',
  [AGENT_METHODS.session_set_config_option]: 'SetSessionConfigOptionRequest',
  [AGENT_METHODS.nes_start]: 'StartNesRequest',
  [AGENT_METHODS.nes_suggest]: 'SuggestNesRequest',
  [AGENT_METHODS.nes_accept]: 'AcceptNesNotification',
  [AGENT_METHODS.nes_reject]: 'RejectNesNotification',
  [AGENT_METHODS.nes_close]: 'CloseNesRequest',
  [AGENT_METHODS.document_did_open]: 'DidOpenDocumentNotification',
  [AGENT_METHODS.document_did_change]: 'DidChangeDocumentNotification',
  [AGENT_METHODS.document_did_close]: 'DidCloseDocumentNotification',
  [AGENT_METHODS.document_did_save]: 'DidSaveDocumentNotification',
  [AGENT_METHODS.document_did_focus]: 'DidFocusDocumentNotification',

  // agent -> client
  [CLIENT_METHODS.session_update]: 'SessionNotification',
  [CLIENT_METHODS.session_request_permission]: 'RequestPermissionRequest',
  [CLIENT_METHODS.fs_read_text_file]: 'ReadTextFileRequest',
  [CLIENT_METHODS.fs_write_text_file]: 'WriteTextFileRequest',
  [CLIENT_METHODS.terminal_create]: 'CreateTerminalRequest',
  [CLIENT_METHODS.terminal_output]: 'TerminalOutputRequest',
  [CLIENT_METHODS.terminal_kill]: 'KillTerminalRequest',
  [CLIENT_METHODS.terminal_release]: 'ReleaseTerminalRequest',
  [CLIENT_METHODS.terminal_wait_for_exit]: 'WaitForTerminalExitRequest',
  [CLIENT_METHODS.mcp_connect]: 'ConnectMcpRequest',
  [CLIENT_METHODS.mcp_disconnect]: 'DisconnectMcpRequest',
  [CLIENT_METHODS.elicitation_create]: 'CreateElicitationRequest',
  [CLIENT_METHODS.elicitation_complete]: 'CompleteElicitationNotification',

  // both directions
  [PROTOCOL_METHODS.cancel_request]: 'CancelRequestNotification',
};

/** `mcp/message` exists on both sides with different shapes, so it is ambiguous. */
const AMBIGUOUS = new Set<string>(['mcp/message']);

const validators = new Map<string, ValidateFunction | null>();

function validatorFor(def: string): ValidateFunction | null {
  const cached = validators.get(def);
  if (cached !== undefined) return cached;
  const compiled = ajv.getSchema(`acp#/$defs/${def}`) ?? null;
  validators.set(def, compiled);
  return compiled;
}

/** Reports any table entry whose definition is missing from the shipped schema. */
export function checkValidatorTable(): string[] {
  const broken: string[] = [];
  for (const [method, def] of Object.entries(PARAMS_DEF)) {
    if (validatorFor(def) === null) broken.push(`${method} -> $defs/${def}`);
  }
  return broken;
}

export interface ValidationResult {
  problems: string[];
  /** False when this method's params have no schema to check against. */
  checked: boolean;
}

export function validateParams(method: string, params: unknown): ValidationResult {
  if (AMBIGUOUS.has(method)) return { problems: [], checked: false };

  const def = PARAMS_DEF[method];
  if (def === undefined) return { problems: [], checked: false };

  const validate = validatorFor(def);
  if (validate === null) return { problems: [], checked: false };

  // A params-less call is legal for definitions with no required fields.
  const subject = params ?? {};
  if (validate(subject)) return { problems: [], checked: true };

  return { problems: summarise(validate.errors ?? [], def), checked: true };
}

/**
 * Collapses ajv's output into something a human can act on.
 *
 * These definitions contain unions, so one wrong field yields an error per
 * branch it failed to match. The union-level noise is dropped and only the
 * deepest, most specific paths are kept.
 */
function summarise(errors: NonNullable<ValidateFunction['errors']>, def: string): string[] {
  const specific = errors.filter((e) => e.keyword !== 'anyOf' && e.keyword !== 'oneOf');
  const chosen = specific.length > 0 ? specific : errors;

  const deepest = chosen.reduce(
    (max, e) => Math.max(max, (e.instancePath ?? '').split('/').length),
    0,
  );

  const seen = new Set<string>();
  const messages: string[] = [];
  for (const error of chosen) {
    if ((error.instancePath ?? '').split('/').length < deepest) continue;
    const where = error.instancePath === '' ? `params (${def})` : `params${error.instancePath}`;
    const text = `${where} ${error.message ?? 'is invalid'}`;
    if (seen.has(text)) continue;
    seen.add(text);
    messages.push(text);
    if (messages.length >= 6) break;
  }
  return messages;
}
