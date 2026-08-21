import { useCallback, useMemo, useState } from 'react';
import { Composer } from './components/Composer';
import { Detail } from './components/Detail';
import { PendingPanel } from './components/PendingPanel';
import { DEFAULT_FILTERS, Timeline, type Filters } from './components/Timeline';
import { Toolbar } from './components/Toolbar';
import { clientCapabilities } from './templates';
import { useInspector } from './useInspector';

export function App() {
  const { connection, state, entries, notices, send, dismissNotice } = useInspector();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);

  const selected = useMemo(
    () => entries.find((entry) => entry.seq === selectedSeq) ?? null,
    [entries, selectedSeq],
  );

  /**
   * The two calls every session starts with. Sent back to back: `session/new`
   * is only legal after `initialize`, but the agent answers in order and the
   * timeline shows whether it did.
   */
  const connectSequence = useCallback(() => {
    if (!state) return;
    send({
      type: 'send',
      assignId: true,
      message: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: state.protocolVersion,
          clientCapabilities: clientCapabilities(state.capabilities),
          clientInfo: { name: 'acp-debugger', version: '0.0.1' },
        },
      },
    });
    send({
      type: 'send',
      assignId: true,
      message: {
        jsonrpc: '2.0',
        method: 'session/new',
        params: { cwd: state.agent.cwd ?? '', mcpServers: [] },
      },
    });
  }, [send, state]);

  if (!state) {
    return (
      <div className="app loading">
        <p>
          {connection === 'open'
            ? 'Waiting for inspector state...'
            : `Control socket ${connection}. Is the token in this URL still valid?`}
        </p>
      </div>
    );
  }

  return (
    <div className="app">
      <Toolbar
        state={state}
        connection={connection}
        send={send}
        onConnectSequence={connectSequence}
      />

      {notices.length > 0 && (
        <ul className="notices">
          {notices.map((notice) => (
            <li key={notice.id} className={`notice notice-${notice.level}`}>
              {notice.text}
              <button type="button" onClick={() => dismissNotice(notice.id)}>
                dismiss
              </button>
            </li>
          ))}
        </ul>
      )}

      <PendingPanel pending={state.pending} send={send} />

      <main className="panes">
        <Timeline
          entries={entries}
          filters={filters}
          onFiltersChange={setFilters}
          selectedSeq={selectedSeq}
          onSelect={setSelectedSeq}
          follow={follow}
          onFollowChange={setFollow}
        />
        <Detail entry={selected} />
      </main>

      <Composer state={state} send={send} />
    </div>
  );
}
