import { useEffect, useState } from 'react';
import type { ClientCommand, InspectorState } from '../../shared/wire';
import { ALL_METHODS, templateFor, type TemplateContext } from '../templates';

interface ComposerProps {
  state: InspectorState;
  send: (command: ClientCommand) => void;
}

export function Composer({ state, send }: ComposerProps) {
  const [method, setMethod] = useState('initialize');
  const [paramsText, setParamsText] = useState('{}');
  const [asNotification, setAsNotification] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** True once the params have been hand-edited, so refills stop overwriting them. */
  const [dirty, setDirty] = useState(false);

  const context: TemplateContext = {
    protocolVersion: state.protocolVersion,
    capabilities: state.capabilities,
    cwd: state.agent.cwd ?? '',
    sessionId: state.sessionId,
  };

  const fillFromTemplate = (target: string): void => {
    const template = templateFor(target);
    setParamsText(JSON.stringify(template.params(context), null, 2));
    setAsNotification(template.notification);
    setError(null);
    setDirty(false);
  };

  // Choosing a method always refills. A change in session state refills only
  // while the params are untouched: typing a prompt and having it replaced the
  // moment a session/update lands would make the composer unusable.
  useEffect(() => {
    fillFromTemplate(method);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method]);

  useEffect(() => {
    if (!dirty) fillFromTemplate(method);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sessionId, state.protocolVersion, state.capabilities, state.agent.cwd]);

  /**
   * Whether the composed params carry an empty `sessionId`. Surfaced as a hint
   * rather than a block: sending a deliberately broken frame is a supported use
   * of this tool, so the composer warns and still lets you send it.
   */
  const needsSession = (() => {
    try {
      const parsed = JSON.parse(paramsText) as { sessionId?: unknown };
      return parsed?.sessionId === '';
    } catch {
      return false;
    }
  })();

  const submit = (): void => {
    let params: unknown;
    try {
      params = paramsText.trim() === '' ? undefined : JSON.parse(paramsText);
    } catch (parseError) {
      setError(`params are not valid JSON: ${String(parseError)}`);
      return;
    }
    setError(null);
    send({
      type: 'send',
      message: { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) },
      assignId: !asNotification,
    });
  };

  return (
    <section className="composer">
      <div className="composer-head">
        <select value={method} onChange={(event) => setMethod(event.target.value)}>
          {ALL_METHODS.map((name) => (
            <option key={name} value={name}>
              {name}
              {templateFor(name).curated ? '' : ' \u00b7 no template'}
            </option>
          ))}
        </select>
        <input
          className="method-override"
          type="text"
          value={method}
          onChange={(event) => setMethod(event.target.value)}
          aria-label="method name"
          title="Editable: send an extension method or a deliberate typo"
        />
        <label className="inline" title="Notifications carry no id and get no response">
          <input
            type="checkbox"
            checked={asNotification}
            onChange={(event) => setAsNotification(event.target.checked)}
          />
          as notification
        </label>
        <button type="button" onClick={() => fillFromTemplate(method)} title="Discard edits and refill from the template">
          Reset
        </button>
        <button
          type="button"
          className="primary"
          onClick={submit}
          disabled={!state.agent.running}
        >
          Send
        </button>
      </div>

      <textarea
        className={needsSession ? 'params needs-session' : 'params'}
        spellCheck={false}
        value={paramsText}
        onChange={(event) => {
          setParamsText(event.target.value);
          setDirty(true);
        }}
        rows={8}
      />
      {needsSession && (
        <p className="hint">
          <strong>{method}</strong> needs a session and there is none yet. Press{' '}
          <strong>initialize + session/new</strong>, or send <code>session/new</code> first. Sending
          it anyway is allowed and the agent will reject it.
        </p>
      )}
      {error && <p className="violations">{error}</p>}
    </section>
  );
}
