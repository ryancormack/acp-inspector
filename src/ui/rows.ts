import type { LogEntry } from '../shared/wire';
import { collapseUpdates, frameRowId, type TimelineRow } from '../shared/transcript';

/** How `session/update` frames are presented. */
export type UpdatesView = 'raw' | 'collapsed' | 'hidden';

export interface Filters {
  text: string;
  showOut: boolean;
  showIn: boolean;
  showStderr: boolean;
  showMeta: boolean;
  updates: UpdatesView;
  onlyViolations: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  text: '',
  showOut: true,
  showIn: true,
  showStderr: true,
  showMeta: true,
  // Collapsed by default: a token-streaming agent makes the raw view unreadable,
  // and the raw frames are one dropdown away.
  updates: 'collapsed',
  onlyViolations: false,
};

/**
 * Applies the direction filters to raw frames, folds `session/update` according
 * to the chosen view, then applies the text and problem filters to the
 * resulting rows so a search matches reassembled transcript text too.
 *
 * Lives outside the component because the selected row has to be resolved from
 * the same array the timeline rendered; deriving rows twice would let the detail
 * pane disagree with the list.
 */
export function buildRows(entries: LogEntry[], filters: Filters): TimelineRow[] {
  const byDirection = entries.filter((entry) => {
    if (entry.dir === 'out') return filters.showOut;
    if (entry.dir === 'in') return filters.showIn;
    if (entry.dir === 'stderr') return filters.showStderr;
    if (entry.dir === 'meta') return filters.showMeta;
    return true;
  });

  const scoped =
    filters.updates === 'hidden'
      ? byDirection.filter((entry) => entry.method !== 'session/update')
      : byDirection;

  const rows: TimelineRow[] =
    filters.updates === 'collapsed'
      ? collapseUpdates(scoped)
      : scoped.map((entry) => ({
          type: 'frame' as const,
          id: frameRowId(entry.seq),
          seq: entry.seq,
          entry,
        }));

  const needle = filters.text.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.onlyViolations) {
      // Groups carry no protocol verdict of their own.
      if (row.type === 'group') return false;
      if (!row.entry.violations?.length && row.entry.kind !== 'malformed') return false;
    }
    if (needle === '') return true;
    if (row.type === 'group') {
      return (
        row.group.text.toLowerCase().includes(needle) ||
        row.group.label.toLowerCase().includes(needle)
      );
    }
    return (
      row.entry.raw.toLowerCase().includes(needle) ||
      (row.entry.method?.toLowerCase().includes(needle) ?? false)
    );
  });
}

/** Changes whenever a row's visible content changes, including a growing group. */
export function rowFingerprint(row: TimelineRow): string {
  return row.type === 'group' ? `${row.id}:${row.group.count}` : row.id;
}
