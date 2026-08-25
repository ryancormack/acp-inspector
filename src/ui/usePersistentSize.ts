import { useCallback, useEffect, useState } from 'react';

/**
 * A pane size the user has dragged, remembered across reloads.
 *
 * Debugging sessions are long and the right split depends on what you are
 * looking at: a wide detail pane for reading a folded transcript, a wide
 * timeline for scanning frames. Losing that on every reload makes the tool feel
 * like it is fighting you.
 */
export function usePersistentSize(
  key: string,
  fallback: number,
  bounds: () => { min: number; max: number },
): readonly [number, (next: number) => void] {
  const [size, setSize] = useState<number>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      const parsed = stored === null ? Number.NaN : Number(stored);
      return Number.isFinite(parsed) ? parsed : fallback;
    } catch {
      // localStorage can throw in a locked-down browser context; the size is a
      // convenience, so fall back rather than failing to render.
      return fallback;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(size));
    } catch {
      /* not worth surfacing */
    }
  }, [key, size]);

  const set = useCallback(
    (next: number) => {
      const { min, max } = bounds();
      setSize(Math.min(Math.max(next, min), Math.max(min, max)));
    },
    [bounds],
  );

  return [size, set] as const;
}
