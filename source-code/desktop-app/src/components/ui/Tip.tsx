/* ============================================================
   TIP — the small "i" and the bubble it opens: point at it or click
   it, and the more there is to say appears.

   Every explanation in the app sits behind one of these, never as a
   sentence on the screen. A mouse pointing at the "i" opens the
   bubble; a click or a tap keeps it open until a click elsewhere,
   Esc or a phone's Back; Tab reaches the "i" and Enter opens it (it
   is a button).

   The bubble is a solid card with a hairline (nothing see-through),
   portalled to <body> so a scrolling panel or a clipped table can
   never cut it. It opens under the "i", above when the window has no
   room under it, and always stays inside the window.

   USAGE
     <InfoTip label="Checks at once">How many proxies are checked at the same time.</InfoTip>

     // Any trigger of your own (the privacy check's marks):
     const tip = useTip(<>DNS: looked up in Germany, like your exit.</>);
     <button {...tip.trigger}>DNS</button>{tip.bubble}
   ============================================================ */

import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBack } from "../../lib/back";

/** Between the trigger and the bubble, and from the window's edges. */
const GAP = 8;
const MARGIN = 10;
/** A pointer passing over an "i" on its way elsewhere opens nothing. */
const OPEN_DELAY_MS = 110;
/** Time to move from the "i" into the bubble (to select its words). */
const CLOSE_DELAY_MS = 160;

type Place = { left: number; top: number };

export type TipTrigger = {
  ref: (el: HTMLElement | null) => void;
  onPointerEnter: (e: PointerEvent) => void;
  onPointerLeave: (e: PointerEvent) => void;
  onClick: () => void;
  onFocus: (e: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
  "aria-expanded": boolean;
  "aria-describedby"?: string;
};

/** The behaviour of a tip, for any trigger: spread `trigger` on it and
    render `bubble` anywhere (it portals itself). */
export function useTip(content: ReactNode): { trigger: TipTrigger; bubble: ReactNode; open: boolean } {
  const id = useId();
  const triggerEl = useRef<HTMLElement | null>(null);
  const bubbleEl = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  // Opened by a click or a tap: stays until a click elsewhere or Esc.
  const [pinned, setPinned] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const later = (fn: () => void, ms: number) => {
    clear();
    timer.current = window.setTimeout(fn, ms);
  };
  const close = () => {
    clear();
    setOpen(false);
    setPinned(false);
  };
  useEffect(() => clear, []);
  // A phone's Back closes a bubble a tap opened (lib/back.ts).
  useBack(open && pinned, close);

  // Where the bubble goes: measured before the browser paints, so it never
  // flashes in the corner first.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const t = triggerEl.current;
      const b = bubbleEl.current;
      if (!t || !b) return;
      const r = t.getBoundingClientRect();
      const w = b.offsetWidth;
      const h = b.offsetHeight;
      const roomBelow = window.innerHeight - r.bottom - GAP - MARGIN;
      const above = roomBelow < h && r.top - GAP - MARGIN >= h;
      const top = above ? r.top - GAP - h : Math.min(r.bottom + GAP, window.innerHeight - MARGIN - h);
      const left = Math.round(Math.max(MARGIN, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - MARGIN - w)));
      const y = Math.round(Math.max(MARGIN, top));
      setPlace((p) => (p && p.left === left && p.top === y ? p : { left, top: y }));
    };
    measure();
    // A scroll or a resize moves the trigger: the bubble follows.
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open, content]);

  // A click or a tap anywhere else closes it; so does Esc, which also hands
  // the keyboard back to the "i".
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const n = e.target as Node | null;
      if (n && (triggerEl.current?.contains(n) || bubbleEl.current?.contains(n))) return;
      close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
      triggerEl.current?.focus();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  const trigger: TipTrigger = {
    ref: (el) => {
      triggerEl.current = el;
    },
    // Only a mouse hovers: a finger's touch is a click, handled below.
    onPointerEnter: (e) => {
      if (e.pointerType === "mouse") later(() => setOpen(true), OPEN_DELAY_MS);
    },
    onPointerLeave: (e) => {
      if (e.pointerType === "mouse" && !pinned) later(() => setOpen(false), CLOSE_DELAY_MS);
    },
    onClick: () => {
      clear();
      if (pinned) close();
      else {
        setOpen(true);
        setPinned(true);
      }
    },
    // The keyboard opens it on the way past; a mouse click focuses too, and
    // that click pins it, so only a visible focus opens it here.
    onFocus: (e) => {
      if (e.currentTarget.matches(":focus-visible")) setOpen(true);
    },
    onBlur: () => {
      if (!pinned) later(() => setOpen(false), CLOSE_DELAY_MS);
    },
    "aria-expanded": open,
    "aria-describedby": open ? id : undefined,
  };

  const bubble = open
    ? createPortal(
        <div
          ref={bubbleEl}
          id={id}
          role="tooltip"
          className="ux-tip"
          style={place ? { left: place.left, top: place.top } : { left: -9999, top: 0, visibility: "hidden" }}
          onPointerEnter={(e) => e.pointerType === "mouse" && clear()}
          onPointerLeave={(e) => e.pointerType === "mouse" && !pinned && later(() => setOpen(false), CLOSE_DELAY_MS)}
        >
          {content}
        </div>,
        document.body,
      )
    : null;

  return { trigger, bubble, open };
}

/** The "i": a plain mark, no fill behind it. Its colour turns blue while its
    bubble is open. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const tip = useTip(children);
  return (
    <>
      <button type="button" className="ux-info" aria-label={`About ${label}`} {...tip.trigger}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6" />
          <path d="M11 7h2v2h-2z" className="dot" />
        </svg>
      </button>
      {tip.bubble}
    </>
  );
}
