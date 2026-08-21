import { useState } from 'react';
import type { LogEntry } from '../../shared/wire';
import type { TimelineRow, TranscriptGroup } from '../../shared/transcript';

interface DetailProps {
  row: TimelineRow | null;
  /** Jump the timeline to one of a group's constituent frames. */
  onSelectFrame: (seq: number) => void;
}

export function Detail({ row, onSelectFrame }: DetailProps) {
  if (row === null) {
    return (
      <section className="detail">
        <p className="empty">Select a row to inspect it.</p>
      </section>
    );
  }

  return row.type === 'group' ? (
    <GroupDetail group={row.group} onSelectFrame={onSelectFrame} />
  ) : (
    <FrameDetail entry={row.entry} />
  );
}

function GroupDetail({
  group,
  onSelectFrame,
}: {
  group: TranscriptGroup;
  onSelectFrame: (seq: number) => void;
}) {
  const elapsed = group.endTs - group.ts;
  return (
    <section className="detail">
      <div className="detail-head">
        <strong>{group.label}</strong>
        <span className="muted">
          {group.count} frame{group.count === 1 ? '' : 's'}
        </span>
        <span className="muted">
          #{group.firstSeq}
          {group.lastSeq !== group.firstSeq ? `-${group.lastSeq}` : ''}
        </span>
        {elapsed > 0 && <span className="muted">{elapsed}ms</span>}
        {group.toolKind && <code>{group.toolKind}</code>}
        {group.toolStatus && <span className="badge">{group.toolStatus}</span>}
        <span className="spacer" />
        <button type="button" onClick={() => void navigator.clipboard?.writeText(group.text)}>
          copy
        </button>
      </div>

      {group.attachments?.length ? (
        <ul className="attachments">
          {group.attachments.map((attachment, index) => (
            <li key={`${attachment}-${index}`}>{attachment}</li>
          ))}
        </ul>
      ) : null}

      {/* Reassembled prose, not JSON: this is the message the agent produced. */}
      <div className="transcript">
        {group.text === '' ? <p className="empty">No text content.</p> : group.text}
      </div>

      <details className="frame-list">
        <summary>
          {group.count} folded frame{group.count === 1 ? '' : 's'}
        </summary>
        <div className="frame-links">
          {group.seqs.map((seq) => (
            <button type="button" key={seq} className="seq-link" onClick={() => onSelectFrame(seq)}>
              #{seq}
            </button>
          ))}
        </div>
      </details>
    </section>
  );
}

function FrameDetail({ entry }: { entry: LogEntry }) {
  const [tab, setTab] = useState<'parsed' | 'raw'>('parsed');

  return (
    <section className="detail">
      <div className="detail-head">
        <strong>#{entry.seq}</strong>
        <span className="muted">{entry.dir}</span>
        <span className="muted">{entry.kind}</span>
        {entry.method && <code>{entry.method}</code>}
        {entry.id !== undefined && <span className="muted">id {String(entry.id)}</span>}
        {entry.durationMs !== undefined && <span className="muted">{entry.durationMs}ms</span>}
        <span className="spacer" />
        <button
          type="button"
          className={tab === 'parsed' ? 'active' : ''}
          onClick={() => setTab('parsed')}
        >
          parsed
        </button>
        <button
          type="button"
          className={tab === 'raw' ? 'active' : ''}
          onClick={() => setTab('raw')}
        >
          raw
        </button>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(entry.raw)}>
          copy
        </button>
      </div>

      {entry.violations?.length ? (
        <ul className="violations">
          {entry.violations.map((violation) => (
            <li key={violation}>{violation}</li>
          ))}
        </ul>
      ) : null}

      {entry.parseError && <p className="violations">JSON parse error: {entry.parseError}</p>}

      <pre className="payload">
        {tab === 'raw' || !entry.msg ? entry.raw : JSON.stringify(entry.msg, null, 2)}
      </pre>
    </section>
  );
}
