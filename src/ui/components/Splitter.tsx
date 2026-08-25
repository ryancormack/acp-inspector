import { useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from 'react';

export type SplitterOrientation = 'vertical' | 'horizontal';

interface SplitterProps {
  /** `vertical` is a vertical bar dragged left and right. */
  orientation: SplitterOrientation;
  /** Called with the pointer's clientX (vertical) or clientY (horizontal). */
  onDragTo: (coordinate: number) => void;
  /** Called with a signed pixel step for keyboard resizing. */
  onNudge: (deltaPx: number) => void;
  /** Restores the default size. */
  onReset: () => void;
  label: string;
}

const KEYBOARD_STEP = 16;
const KEYBOARD_STEP_LARGE = 96;

/**
 * A drag handle between two panes.
 *
 * Uses pointer capture rather than window-level listeners, so a fast drag that
 * leaves the handle still tracks, and the drag always ends even if the pointer
 * is released outside the window.
 *
 * Exposed as an ARIA separator with arrow-key resizing: a 6px target is not
 * reachable for anyone who cannot use a mouse precisely, and double-click or
 * Home restores the default.
 */
export function Splitter({ orientation, onDragTo, onNudge, onReset, label }: SplitterProps) {
  const dragging = useRef(false);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // preventDefault stops text selection while dragging, but it also suppresses
    // the default focus-on-mousedown, so focus has to be moved explicitly or the
    // arrow-key resizing below is unreachable after a click.
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = true;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    onDragTo(orientation === 'vertical' ? event.clientX : event.clientY);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;

    if (event.key === decrease) {
      event.preventDefault();
      onNudge(-step);
      return;
    }
    if (event.key === increase) {
      event.preventDefault();
      onNudge(step);
      return;
    }
    if (event.key === 'Home' || event.key === 'Enter') {
      event.preventDefault();
      onReset();
    }
  };

  return (
    <div
      className={`splitter splitter-${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    >
      <span className="splitter-grip" aria-hidden="true" />
    </div>
  );
}
