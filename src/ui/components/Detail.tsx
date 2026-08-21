import { useState } from 'react';
import type { LogEntry } from '../../shared/wire';

interface DetailProps {
  entry: LogEntry | null;
}

export function Detail({ entry }: DetailProps) {
  const [tab, setTab] = useState<'parsed' | 'raw'>('parsed');

  if (!entry) {
    return (
      <section className="detail">
        <p className="empty">Select a frame to inspect it.</p>
      </section>
    );
  }

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
        <button type="button" className={tab === 'raw' ? 'active' : ''} onClick={() => setTab('raw')}>
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
