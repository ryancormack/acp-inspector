import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClientCommand,
  InspectorState,
  LogEntry,
  ServerEvent,
} from '../shared/wire';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** Rows kept in the browser. The server keeps its own, larger, ring buffer. */
const MAX_UI_ENTRIES = 10_000;

export interface Inspector {
  connection: ConnectionState;
  state: InspectorState | null;
  entries: LogEntry[];
  notices: Notice[];
  send: (command: ClientCommand) => void;
  dismissNotice: (id: number) => void;
}

export function useInspector(): Inspector {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [state, setState] = useState<InspectorState | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const noticeId = useRef(0);

  const url = useMemo(() => {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${window.location.host}/ws?token=${encodeURIComponent(token)}`;
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: number | undefined;
    let attempt = 0;

    const connect = (): void => {
      const socket = new WebSocket(url);
      socketRef.current = socket;
      setConnection('connecting');

      socket.onopen = () => {
        attempt = 0;
        setConnection('open');
      };

      socket.onmessage = (event) => {
        const parsed = JSON.parse(String(event.data)) as ServerEvent;
        switch (parsed.type) {
          case 'hello':
            setState(parsed.state);
            setEntries(parsed.log);
            return;
          case 'state':
            setState(parsed.state);
            return;
          case 'log':
            setEntries((previous) => {
              const next = previous.concat(parsed.entries);
              return next.length > MAX_UI_ENTRIES ? next.slice(next.length - MAX_UI_ENTRIES) : next;
            });
            return;
          case 'cleared':
            setEntries([]);
            return;
          case 'notice':
            setNotices((previous) =>
              previous.concat({ id: ++noticeId.current, level: parsed.level, text: parsed.text }),
            );
            return;
        }
      };

      socket.onclose = () => {
        setConnection('closed');
        if (closed) return;
        attempt += 1;
        retry = window.setTimeout(connect, Math.min(500 * attempt, 5000));
      };

      socket.onerror = () => socket.close();
    };

    connect();

    return () => {
      closed = true;
      if (retry !== undefined) window.clearTimeout(retry);
      socketRef.current?.close();
    };
  }, [url]);

  const send = useCallback((command: ClientCommand) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((previous) => previous.filter((notice) => notice.id !== id));
  }, []);

  return { connection, state, entries, notices, send, dismissNotice };
}
