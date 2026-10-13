/* ============================================================
   ROLL — numbers whose digits turn over like a counter: every
   digit is a wheel of 0 to 9 that turns to its value inside its
   own box (styles/globals.css, "Rolling digits"; it moves,
   nothing fades). A wheel that gets a new value while still
   turning heads for it from where it is, so a count that changes
   twenty times a second spins its last digit and keeps the others
   still, and stays readable.

   At rest a number is plain text: one run of type, kerned and on
   the line like every word around it. Only while it changes is it
   wheels, and each wheel stands exactly where its digit stands in
   the plain text (the advances are measured from it), so the last
   frame of a turn is the plain text to the pixel and the swap back
   cannot be seen. Until 2026-10-12 the wheels stayed after the
   turn: a box per digit loses the font's kerning (Inter pulls ".1"
   together, up to 5 px over an address) and a wheel of 19.5 px
   cells rested odd digits half a pixel off, which read as jumbled
   numbers on a 100 % screen.

     Roll       a count: each digit keeps its place from the right,
                so the ones digit is always the same wheel. The
                wheels turn the way the count goes: up, 9 turns on
                to 0 (it ran back down through every digit before,
                2026-10-11), and a new first digit turns up from 0
     DigitRoll  an address: each digit keeps its place from the
                left, so a new exit turns every changed digit over,
                straight to its new value

   Read as one text by screen readers.

   USAGE   <b><Roll value={spaced(working.length)} /></b>
           <DigitRoll text={health.exit_ip} />
   ============================================================ */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const GLIDE = "cubic-bezier(0.2, 0.9, 0.1, 1)";

/* A wheel is the ten digits twice over: it rests on the first ten, and a turn
   that carries on past 9 lands in the second ten, which looks the same, so
   when the turn ends the wheel is back on its resting place unseen. */
const WHEEL = [..."0123456789", ..."0123456789"];
const CELL = 100 / WHEEL.length;
const at = (cell: number) => `translateY(${-cell * CELL}%)`;

/* After a turn's last change, how long the wheels stay before the number is
   plain text again: the turn itself, and a frame or two to land. */
const SETTLE_MS = 80;

type Way = 1 | -1 | 0;
type From = "left" | "right";

function quiet(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Where a turning wheel is right now, in cells (it can be between two). */
function turning(strip: HTMLElement): number | null {
  const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(strip).transform);
  const cell = strip.offsetHeight / WHEEL.length;
  if (!m || !cell) return null;
  return -Number(m[1].split(",")[5]) / cell;
}

/** A character's place: from the left for an address, from the right for a count. */
const placeOf = (length: number, i: number, from: From) => (from === "right" ? length - i : i);

/** The digit at each place of `text`: where each wheel starts when the text changes. */
function digitsOf(text: string, from: From): Map<number, number> {
  const chars = [...text];
  const out = new Map<number, number>();
  chars.forEach((c, i) => {
    if (/\d/.test(c)) out.set(placeOf(chars.length, i, from), Number(c));
  });
  return out;
}

/** Each character's advance when `text` is set as one run inside `host` (same type,
    kerning included), or null when it is not laid out (a page kept behind another). */
function advances(host: HTMLElement, text: string): number[] | null {
  const probe = document.createElement("span");
  probe.className = "probe";
  probe.textContent = text;
  host.appendChild(probe);
  try {
    const node = probe.firstChild;
    if (!(node instanceof Text)) return null;
    const range = document.createRange();
    const lefts: number[] = [];
    let i = 0;
    for (const c of text) {
      range.setStart(node, i);
      range.setEnd(node, i + c.length);
      lefts.push(range.getBoundingClientRect().left);
      i += c.length;
    }
    const box = probe.getBoundingClientRect();
    if (box.width === 0) return null;
    return lefts.map((left, k) => (k + 1 < lefts.length ? lefts[k + 1] : box.right) - left);
  } finally {
    probe.remove();
  }
}

/**
 * One digit while it turns. `way` is how the whole number went: up turns the
 * wheel forward (9 on to 0), down turns it back, 0 takes it straight to the new
 * digit. `start` is the digit it showed before (0 for a place that is new).
 * `width` is this digit's advance in the plain text, so the wheel stands where
 * the digit will stand.
 */
function Digit({ d, way, ms, start, width }: { d: number; way: Way; ms: number; start: number; width: number }) {
  const strip = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  useLayoutEffect(() => {
    const before = shown.current ?? start;
    shown.current = d;
    const el = strip.current;
    if (!el || before === d || typeof el.animate !== "function") return;
    // Still turning: carry on from where it is (React has already set the new resting place,
    // so a wheel at rest is read from the digit it showed).
    const moving = el.getAnimations();
    let from = (moving.length > 0 ? turning(el) : null) ?? before;
    moving.forEach((a) => a.cancel());
    let to = d;
    if (way > 0) {
      from %= 10;
      if (to < from) to += 10;
    } else if (way < 0) {
      if (from < 10) from += 10;
      if (to + 10 <= from) to += 10;
    } else {
      from %= 10;
    }
    el.animate([{ transform: at(from) }, { transform: at(to) }], { duration: ms, easing: GLIDE });
    // `start` and `way` only matter at the moment the digit changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
  return (
    <span className="digit" aria-hidden="true" style={{ width }}>
      <span className="size">{d}</span>
      <span ref={strip} className="strip" style={{ transform: at(d) }}>
        {WHEEL.map((n, i) => (
          <span key={i}>{n}</span>
        ))}
      </span>
    </span>
  );
}

type Turn = { starts: Map<number, number>; widths: number[] };

function Digits({ text, from, way, ms }: { text: string; from: From; way: Way; ms: number }) {
  const host = useRef<HTMLSpanElement>(null);
  const before = useRef<string | null>(null);
  const settle = useRef<number | undefined>(undefined);
  const [turn, setTurn] = useState<Turn | null>(null);

  // A change after the first showing turns the wheels, from the digits shown before; a little
  // after the last change the number is plain text again. Measured and set before the browser
  // paints, so the new text never shows plain for a frame first.
  useLayoutEffect(() => {
    const was = before.current;
    before.current = text;
    if (was === null || was === text || quiet() || !host.current) return;
    const widths = advances(host.current, text);
    window.clearTimeout(settle.current);
    if (!widths) {
      setTurn(null);
      return;
    }
    setTurn((t) => ({ starts: t?.starts ?? digitsOf(was, from), widths }));
    settle.current = window.setTimeout(() => setTurn(null), ms + SETTLE_MS);
  }, [text, from, ms]);
  useEffect(() => () => window.clearTimeout(settle.current), []);

  if (!turn) {
    return (
      <span ref={host} className="ux-digits">
        {text}
      </span>
    );
  }
  const chars = [...text];
  return (
    <span ref={host} className="ux-digits is-turning" aria-label={text}>
      {chars.map((c, i) => {
        const place = placeOf(chars.length, i, from);
        const width = turn.widths[i] ?? 0;
        return /\d/.test(c) ? (
          <Digit key={place} d={Number(c)} way={way} ms={ms} start={turn.starts.get(place) ?? 0} width={width} />
        ) : (
          <span key={place} className="sep" aria-hidden="true" style={{ width }}>
            {c}
          </span>
        );
      })}
    </span>
  );
}

/* A count's turn takes as long as the count gives it: a full 360 ms when it
   moves now and then, down to a crisp 140 ms when it changes ten times a
   second, so each value lands before the next one comes and can be read. */
const COUNT_MS = 360;
const COUNT_MS_FAST = 140;

export function Roll({ value }: { value: string }) {
  const n = Number(value.replace(/\D/g, "")) || 0;
  const last = useRef({ n, t: 0 });
  const way: Way = n > last.current.n ? 1 : n < last.current.n ? -1 : 0;
  const gap = typeof performance === "undefined" ? COUNT_MS : performance.now() - last.current.t;
  const ms = Math.round(Math.min(COUNT_MS, Math.max(COUNT_MS_FAST, gap)));
  useLayoutEffect(() => {
    last.current = { n, t: typeof performance === "undefined" ? 0 : performance.now() };
  }, [n]);
  return <Digits text={value} from="right" way={way} ms={ms} />;
}

export function DigitRoll({ text }: { text: string }) {
  return <Digits text={text} from="left" way={0} ms={620} />;
}
