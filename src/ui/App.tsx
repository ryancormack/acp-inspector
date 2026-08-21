import { useCallback, useMemo, useState } from 'react';
import { Composer } from './components/Composer';
import { Detail } from './components/Detail';
import { PendingPanel } from './components/PendingPanel';
import { Timeline } from './components/Timeline';
import { buildRows, DEFAULT_FILTERS, type Filters } from './rows';
import { frameRowId } from '../shared/transcript';
import { Toolbar } from './components/Toolbar';
import { clientCapabilities } from './templates';
import { useInspector } from './useInspector';

export function App() {
  const { connection, state, entries, notices, send, dismissNotice } = useInspector();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);

  const rows = useMemo(() => buildRows(entries, filters), [entries, filters]);
  const selected = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId],
  );

  /**
   * Selecting a frame from inside a collapsed group only resolves if that frame
   * is a row in its own right, so switching to the raw view is part of the jump.
   */
  const selectFrame = useCallback((seq: number) => {
    setFilters((previous) =>
      previous.updates === 'collapsed' ? { ...previous, updates: 'raw' } : previous,
    );
    setFollow(false);
    setSelectedId(frameRowId(seq));
  }, []);

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
          rows={rows}
          totalFrames={entries.length}
          filters={filters}
          onFiltersChange={setFilters}
          selectedId={selectedId}
          onSelect={setSelectedId}
          follow={follow}
          onFollowChange={setFollow}
        />
        <Detail row={selected} onSelectFrame={selectFrame} />
      </main>

      <Composer state={state} send={send} />
    </div>
  );
}
