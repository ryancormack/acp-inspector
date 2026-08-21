import { useEffect, useMemo, useRef } from 'react';
import type { LogEntry } from '../../shared/wire';

export interface Filters {
  text: string;
  showOut: boolean;
  showIn: boolean;
  showStderr: boolean;
  showMeta: boolean;
  hideSessionUpdates: boolean;
  onlyViolations: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  text: '',
  showOut: true,
  showIn: true,
  showStderr: true,
  showMeta: true,
  hideSessionUpdates: false,
  onlyViolations: false,
};

/** Rows rendered at once. The rest stay in memory and in the export. */
const RENDER_LIMIT = 800;

interface TimelineProps {
  entries: LogEntry[];
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
}

export function Timeline({
  entries,
  filters,
  onFiltersChange,
  selectedSeq,
  onSelect,
  follow,
  onFollowChange,
}: TimelineProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => applyFilters(entries, filters), [entries, filters]);
  const rendered = visible.length > RENDER_LIMIT ? visible.slice(visible.length - RENDER_LIMIT) : visible;

  // Keyed on the newest frame's seq, not on `rendered.length`: once the render
  // cap saturates the length stops changing, and following would silently stop
  // exactly when the stream is busiest.
  const newestSeq = rendered.length > 0 ? rendered[rendered.length - 1]!.seq : 0;

  useEffect(() => {
    if (!follow) return;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [newestSeq, follow]);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]): void =>
    onFiltersChange({ ...filters, [key]: value });

  return (
    <section className="timeline">
      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder="filter method, id, or raw text"
          value={filters.text}
          onChange={(event) => set('text', event.target.value)}
        />
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
        <label className="inline">
          <input
            type="checkbox"
            checked={filters.hideSessionUpdates}
            onChange={(event) => set('hideSessionUpdates', event.target.checked)}
          />
          hide session/update
        </label>
        <label className="inline">
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
          {visible.length}/{entries.length}
        </span>
      </div>

      <div className="rows" ref={listRef}>
        {rendered.length === 0 && (
          <p className="empty">
            Nothing captured yet. Launch the agent, then send <code>initialize</code>.
          </p>
        )}
        {rendered.map((entry) => (
          <button
            type="button"
            key={entry.seq}
            className={[
              'row',
              `dir-${entry.dir}`,
              `kind-${entry.kind}`,
              entry.seq === selectedSeq ? 'selected' : '',
              entry.violations?.length ? 'has-violation' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => onSelect(entry.seq)}
          >
            <span className="seq">{entry.seq}</span>
            <span className="time">{formatTime(entry.ts)}</span>
            <span className="arrow">{arrowFor(entry)}</span>
            <span className="kind">{entry.kind}</span>
            <span className="label">{labelFor(entry)}</span>
            {entry.durationMs !== undefined && <span className="ms">{entry.durationMs}ms</span>}
            {entry.violations?.length ? <span className="flag">!</span> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function applyFilters(entries: LogEntry[], filters: Filters): LogEntry[] {
  const needle = filters.text.trim().toLowerCase();
  return entries.filter((entry) => {
    if (entry.dir === 'out' && !filters.showOut) return false;
    if (entry.dir === 'in' && !filters.showIn) return false;
    if (entry.dir === 'stderr' && !filters.showStderr) return false;
    if (entry.dir === 'meta' && !filters.showMeta) return false;
    if (filters.hideSessionUpdates && entry.method === 'session/update') return false;
    if (filters.onlyViolations && !entry.violations?.length && entry.kind !== 'malformed') {
      return false;
    }
    if (needle.length > 0 && !entry.raw.toLowerCase().includes(needle)) {
      const method = entry.method?.toLowerCase() ?? '';
      if (!method.includes(needle)) return false;
    }
    return true;
  });
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
