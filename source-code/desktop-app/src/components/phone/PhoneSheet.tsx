import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBack } from "../../lib/back";
import { cx } from "../ui/tokens";

/* A sheet that rises from the bottom, for a menu or the details of one thing
   on a phone (a row's ⋯, a dropdown's choices, a checked proxy): within the
   thumb's reach, the page dimmed behind it, the one see-through thing the
   house allows (data-scrim). A tap outside it, a swipe down on its top edge or
   Back closes it, and it slides away the way it came. Below the top edge the
   sheet scrolls when its content is taller than the screen. */

const LEAVE_MS = 200;

export default function PhoneSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** What the menu is about, small, above its choices. */
  title?: string;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(open);
  const [leaving, setLeaving] = useState(false);
  // How far a finger has pulled the sheet down.
  const [pull, setPull] = useState(0);
  const drag = useRef<{ y: number; at: number; id: number } | null>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useBack(open, onClose);

  const wasOpen = useRef(open);
  useEffect(() => {
    const before = wasOpen.current;
    wasOpen.current = open;
    if (open) {
      setShown(true);
      setLeaving(false);
      setPull(0);
      return;
    }
    if (!before) return;
    setLeaving(true);
    const t = window.setTimeout(() => {
      setShown(false);
      setLeaving(false);
      setPull(0);
    }, LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (open && shown) sheet.current?.focus({ preventScroll: true });
  }, [open, shown]);

  if (!shown) return null;

  const down = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { y: e.clientY, at: performance.now(), id: e.pointerId };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = Math.max(0, e.clientY - d.y);
    // Past a few pixels it is a swipe, not a tap on a choice.
    if (dy > 6 && !e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId);
    setPull(dy);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const dy = Math.max(0, e.clientY - d.y);
    const fast = dy / Math.max(1, performance.now() - d.at) > 0.5;
    if (dy > 90 || (fast && dy > 28)) onClose();
    else setPull(0);
  };

  return createPortal(
    <div className={cx("ux-sheetlayer", leaving && "is-leaving")}>
      <button type="button" className="ux-scrim" data-scrim aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="ux-phonesheet"
        style={pull > 0 ? { transform: `translateY(${pull}px)`, transition: "none" } : undefined}
      >
        {/* The top edge is what a finger pulls down. */}
        <div
          className="pull"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => {
            drag.current = null;
            setPull(0);
          }}
        >
          <span className="grip" aria-hidden="true" />
          {title && <p className="head">{title}</p>}
        </div>
        <div className="body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** One choice in a sheet: a big row, its words, and a line under them when it says more. */
export function SheetItem({ label, note, danger, onClick }: { label: string; note?: string; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={cx("ux-sheetitem", danger && "is-danger")} onClick={onClick}>
      <span className="label">{label}</span>
      {note && <span className="note">{note}</span>}
    </button>
  );
}
