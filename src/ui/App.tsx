import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Composer } from './components/Composer';
import { Detail } from './components/Detail';
import { PendingPanel } from './components/PendingPanel';
import { Splitter } from './components/Splitter';
import { Timeline } from './components/Timeline';
import { buildRows, DEFAULT_FILTERS, type Filters } from './rows';
import { frameRowId } from '../shared/transcript';
import { Toolbar } from './components/Toolbar';
import { clientCapabilities } from './templates';
import { useInspector } from './useInspector';
import { usePersistentSize } from './usePersistentSize';

/** Defaults, used on first run and restored by double-clicking a splitter. */
const DEFAULT_TIMELINE_WIDTH = 760;
const DEFAULT_COMPOSER_HEIGHT = 260;
const MIN_PANE = 240;
const MIN_COMPOSER = 96;

export function App() {
  const { connection, state, entries, notices, send, dismissNotice } = useInspector();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const panesRef = useRef<HTMLElement>(null);

  // Bounds are read at drag time rather than captured, so resizing the window
  // does not leave a pane pinned outside the viewport.
  const timelineBounds = useCallback(() => {
    const width = panesRef.current?.clientWidth ?? window.innerWidth;
    return { min: MIN_PANE, max: Math.max(MIN_PANE, width - MIN_PANE) };
  }, []);
  const composerBounds = useCallback(
    () => ({ min: MIN_COMPOSER, max: Math.max(MIN_COMPOSER, window.innerHeight - 320) }),
    [],
  );

  const [timelineWidth, setTimelineWidth] = usePersistentSize(
    'acp-debugger.timelineWidth',
    DEFAULT_TIMELINE_WIDTH,
    timelineBounds,
  );
  const [composerHeight, setComposerHeight] = usePersistentSize(
    'acp-debugger.composerHeight',
    DEFAULT_COMPOSER_HEIGHT,
    composerBounds,
  );

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
    <div
      className="app"
      style={
        {
          '--timeline-width': `${timelineWidth}px`,
          '--composer-height': `${composerHeight}px`,
        } as CSSProperties
      }
    >
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

      <main className="panes" ref={panesRef}>
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
        <Splitter
          orientation="vertical"
          label="Resize the timeline and detail panes"
          onDragTo={(clientX) => {
            const left = panesRef.current?.getBoundingClientRect().left ?? 0;
            setTimelineWidth(clientX - left);
          }}
          onNudge={(delta) => setTimelineWidth(timelineWidth + delta)}
          onReset={() => setTimelineWidth(DEFAULT_TIMELINE_WIDTH)}
        />
        <Detail row={selected} onSelectFrame={selectFrame} />
      </main>

      <Splitter
        orientation="horizontal"
        label="Resize the composer"
        onDragTo={(clientY) => setComposerHeight(window.innerHeight - clientY)}
        onNudge={(delta) => setComposerHeight(composerHeight - delta)}
        onReset={() => setComposerHeight(DEFAULT_COMPOSER_HEIGHT)}
      />

      <Composer state={state} send={send} />
    </div>
  );
}
