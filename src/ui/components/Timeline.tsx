import { useEffect, useRef } from 'react';
import type { LogEntry } from '../../shared/wire';
import type { TimelineRow, TranscriptGroup } from '../../shared/transcript';
import { rowFingerprint, type Filters, type UpdatesView } from '../rows';

/** Rows rendered at once. The rest stay in memory and in the log. */
const RENDER_LIMIT = 800;

interface TimelineProps {
  rows: TimelineRow[];
  totalFrames: number;
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
}

export function Timeline({
  rows,
  totalFrames,
  filters,
  onFiltersChange,
  selectedId,
  onSelect,
  follow,
  onFollowChange,
}: TimelineProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const rendered = rows.length > RENDER_LIMIT ? rows.slice(rows.length - RENDER_LIMIT) : rows;

  // Keyed on the newest row's identity, not on `rendered.length`: once the
  // render cap saturates the length stops changing, and following would
  // silently stop exactly when the stream is busiest. A collapsed group also
  // grows in place without changing the row count.
  const newestKey = rendered.length > 0 ? rowFingerprint(rendered[rendered.length - 1]!) : '';

  useEffect(() => {
    if (!follow) return;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [newestKey, follow]);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]): void =>
    onFiltersChange({ ...filters, [key]: value });

  return (
    <section className="timeline">
      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder="filter method, id, or text"
          value={filters.text}
          onChange={(event) => set('text', event.target.value)}
        />
        <label className="inline" title="How session/update frames are shown">
          updates
          <select
            value={filters.updates}
            onChange={(event) => set('updates', event.target.value as UpdatesView)}
          >
            <option value="collapsed">collapsed</option>
            <option value="raw">raw frames</option>
            <option value="hidden">hidden</option>
          </select>
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={filters.showOut}
            onChange={(event) => set('showOut', event.target.checked)}
          />
          out
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={filters.showIn}
            onChange={(event) => set('showIn', event.target.checked)}
          />
          in
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={filters.showStderr}
            onChange={(event) => set('showStderr', event.target.checked)}
          />
          stderr
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={filters.showMeta}
            onChange={(event) => set('showMeta', event.target.checked)}
          />
          meta
        </label>
        <label className="inline" title="Only frames the inspector flagged">
          <input
            type="checkbox"
            checked={filters.onlyViolations}
            onChange={(event) => set('onlyViolations', event.target.checked)}
          />
          only problems
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => onFollowChange(event.target.checked)}
          />
          follow
        </label>
        <span className="muted count">
          {rows.length} rows / {totalFrames} frames
        </span>
      </div>

      <div className="rows" ref={listRef}>
        {rendered.length === 0 && (
          <p className="empty">
            Nothing captured yet. Launch the agent, then send <code>initialize</code>.
          </p>
        )}
        {rendered.map((row) =>
          row.type === 'group' ? (
            <GroupRow
              key={row.id}
              group={row.group}
              selected={row.id === selectedId}
              onSelect={() => onSelect(row.id)}
            />
          ) : (
            <FrameRow
              key={row.id}
              entry={row.entry}
              selected={row.id === selectedId}
              onSelect={() => onSelect(row.id)}
            />
          ),
        )}
      </div>
    </section>
  );
}

function FrameRow({
  entry,
  selected,
  onSelect,
}: {
  entry: LogEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={[
        'row',
        `dir-${entry.dir}`,
        `kind-${entry.kind}`,
        selected ? 'selected' : '',
        entry.violations?.length ? 'has-violation' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onSelect}
    >
      <span className="seq">{entry.seq}</span>
      <span className="time">{formatTime(entry.ts)}</span>
      <span className="arrow">{arrowFor(entry)}</span>
      <span className="kind">{entry.kind}</span>
      <span className="label">{labelFor(entry)}</span>
      {entry.durationMs !== undefined && <span className="ms">{entry.durationMs}ms</span>}
      {entry.violations?.length ? <span className="flag">!</span> : null}
    </button>
  );
}

function GroupRow({
  group,
  selected,
  onSelect,
}: {
  group: TranscriptGroup;
  selected: boolean;
  onSelect: () => void;
}) {
  const preview = group.text.replace(/\s+/g, ' ').trim();
  return (
    <button
      type="button"
      className={['row', 'row-group', `role-${group.role}`, selected ? 'selected' : '']
        .filter(Boolean)
        .join(' ')}
      onClick={onSelect}
    >
      <span className="seq">{group.firstSeq}</span>
      <span className="time">{formatTime(group.ts)}</span>
      <span className="arrow">{'\u25bc'}</span>
      <span className="kind">{group.label}</span>
      <span className="label">
        {preview === '' ? <em className="muted">(no text)</em> : preview}
        {group.toolStatus && <span className="badge">{group.toolStatus}</span>}
        {group.attachments?.length ? (
          <span className="badge">{group.attachments.length} attachment(s)</span>
        ) : null}
      </span>
      <span className="ms">{'\u00d7'}{group.count}</span>
    </button>
  );
}

function arrowFor(entry: LogEntry): string {
  if (entry.dir === 'out') return '\u2192';
  if (entry.dir === 'in') return '\u2190';
  if (entry.dir === 'stderr') return '\u2591';
  return '\u00b7';
}

function labelFor(entry: LogEntry): string {
  if (entry.dir === 'stderr' || entry.kind === 'meta') return entry.raw;
  if (entry.method) return entry.method;
  if (entry.kind === 'malformed') return entry.parseError ?? 'malformed frame';
  return `id ${String(entry.id)}`;
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}
