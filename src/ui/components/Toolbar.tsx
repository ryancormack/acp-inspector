import type { CapabilityToggles, ClientCommand, InspectorState } from '../../shared/wire';
import type { ConnectionState } from '../useInspector';

interface ToolbarProps {
  state: InspectorState;
  connection: ConnectionState;
  send: (command: ClientCommand) => void;
  onConnectSequence: () => void;
}

const CAPABILITY_LABELS: Array<{ key: keyof CapabilityToggles; label: string; hint: string }> = [
  { key: 'fsRead', label: 'fs.readTextFile', hint: 'Agent may ask us to read files' },
  { key: 'fsWrite', label: 'fs.writeTextFile', hint: 'Agent may ask us to write files' },
  { key: 'terminal', label: 'terminal', hint: 'Agent may ask us to run commands' },
  { key: 'elicitation', label: 'elicitation', hint: 'Agent may ask the user for structured input' },
  { key: 'authTerminal', label: 'auth.terminal', hint: 'We could run the agent interactively' },
];

export function Toolbar({ state, connection, send, onConnectSequence }: ToolbarProps) {
  const { agent, capabilities, negotiated } = state;
  const commandLine = [agent.command ?? '(no command)', ...(agent.args ?? [])].join(' ');

  const toggle = (key: keyof CapabilityToggles): void => {
    send({ type: 'capabilities', capabilities: { ...capabilities, [key]: !capabilities[key] } });
  };

  return (
    <header className="toolbar">
      <div className="toolbar-row">
        <span className={`pill pill-${connection}`}>{connection}</span>
        <span className={`pill ${agent.running ? 'pill-running' : 'pill-stopped'}`}>
          {agent.running ? `agent pid ${agent.pid ?? '?'}` : 'agent stopped'}
        </span>
        <code className="command" title={agent.cwd ?? ''}>
          {commandLine}
        </code>

        {agent.running ? (
          <button type="button" onClick={() => send({ type: 'kill' })}>
            Kill
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => send({ type: 'launch' })}>
            Launch
          </button>
        )}
        <button type="button" onClick={onConnectSequence} disabled={!agent.running}>
          initialize + session/new
        </button>
        <button type="button" onClick={() => send({ type: 'clear' })}>
          Clear log
        </button>
      </div>

      <div className="toolbar-row">
        <label className="inline">
          protocolVersion
          <input
            type="number"
            min={0}
            value={state.protocolVersion}
            onChange={(event) =>
              send({ type: 'protocolVersion', version: Number(event.target.value) })
            }
          />
        </label>

        <span className="caps-label">advertise:</span>
        {CAPABILITY_LABELS.map(({ key, label, hint }) => (
          <label key={key} className="inline" title={hint}>
            <input type="checkbox" checked={capabilities[key]} onChange={() => toggle(key)} />
            {label}
          </label>
        ))}
      </div>

      <div className="toolbar-row summary">
        {negotiated ? (
          <span>
            negotiated v{negotiated.protocolVersion}
            {typeof negotiated.agentInfo === 'object' && negotiated.agentInfo !== null
              ? ` · ${String((negotiated.agentInfo as { name?: string }).name ?? 'agent')}`
              : ''}
          </span>
        ) : (
          <span className="muted">not initialized</span>
        )}
        <span className={state.sessionId ? '' : 'muted'}>
          session: {state.sessionId ?? 'none'}
        </span>
        {state.dropped > 0 && (
          <span className="warn">{state.dropped} older frame(s) dropped from the buffer</span>
        )}
        {!agent.spawnFromBrowserAllowed && (
          <span className="muted">command locked to argv (--allow-browser-spawn to unlock)</span>
        )}
        {agent.exit && (
          <span className="warn">
            last exit: code={String(agent.exit.code)} signal={String(agent.exit.signal)}
          </span>
        )}
      </div>
    </header>
  );
}
