import { useLayoutEffect, type RefObject } from "react";

/* ============================================================
   THE SLIDING PILL — the chosen one in a row of choices (the
   title bar's pages, Proxies' parts, every segmented choice,
   Settings' sections) is one solid blue pill, and it slides to
   the one you press: both edges set off at once, the leading one
   quicker, landing a hair past and settling, the trailing one
   just behind, so it stretches on the way and settles where it
   stops ("The sliding pill" in styles/globals.css).

   The words on it are white exactly where the blue is, letter by
   letter: the pill carries a white copy of the whole row
   (`.ux-pillcopy`), laid over the real one and moved against the
   pill on the pill's own curve, so it stands still on the page
   while the pill slides across it. The row's own words stay as
   they are; the pill covers them. Pressing the chosen one presses
   the pill, its white words with it. (Until 2026-10-11
   the chosen words turned white on a timer, and the pill set off
   after the page it opens, on a curve that starts slowly: it
   looked late.)

   The row is position: relative; the pill is its first child;
   the chosen choice carries `chosen` (a selector). A column of
   choices works the same way up and down. The first placement and
   a window resize put it there at once, a new choice slides it.
   The quiet setting of Windows moves it at once too (the CSS
   drops the transitions).

   USAGE   const row = useRef(null), pill = useRef(null);
           useSlidingPill(row, pill, ".is-active", value);
           <nav ref={row}><i ref={pill} className="ux-pill" />…</nav>
   ============================================================ */

/** The row's choices: every child but the pill. */
function choices(row: HTMLElement, pill: HTMLElement): HTMLElement[] {
  return [...row.children].filter((c): c is HTMLElement => c !== pill && c instanceof HTMLElement);
}

/** The pill's white copy of the row, made once per pill. */
function copyIn(pill: HTMLElement): HTMLElement {
  const had = pill.querySelector<HTMLElement>(":scope > .ux-pillcopy");
  if (had) return had;
  const copy = document.createElement("span");
  copy.className = "ux-pillcopy";
  copy.inert = true;
  pill.append(copy);
  return copy;
}

/** Copy every choice, each laid exactly over the real one. A press is the pill's
    to show (it gives way with the chosen one), so the copies carry none. */
function fill(row: HTMLElement, pill: HTMLElement, copy: HTMLElement): void {
  const twins = choices(row, pill).map((c) => {
    const t = c.cloneNode(true) as HTMLElement;
    t.removeAttribute("id");
    t.removeAttribute("data-press");
    t.removeAttribute("data-ripple");
    t.tabIndex = -1;
    t.style.position = "absolute";
    t.style.margin = "0";
    t.style.left = `${c.offsetLeft}px`;
    t.style.top = `${c.offsetTop}px`;
    t.style.width = `${c.offsetWidth}px`;
    t.style.height = `${c.offsetHeight}px`;
    return t;
  });
  copy.replaceChildren(...twins);
}

export function useSlidingPill(
  row: RefObject<HTMLElement | null>,
  pill: RefObject<HTMLElement | null>,
  chosen: string,
  value: unknown,
): void {
  useLayoutEffect(() => {
    const el = row.current;
    const p = pill.current;
    if (!el || !p) return;
    let frame = 0;
    const copy = copyIn(p);
    const place = (slide: boolean) => {
      // The row's own choice: the copies in the pill match the selector too.
      const on = choices(el, p).find((c) => c.matches(chosen));
      if (!on) {
        p.style.visibility = "hidden";
        return;
      }
      const left = on.offsetLeft;
      const top = on.offsetTop;
      const right = el.clientWidth - left - on.offsetWidth;
      const bottom = el.clientHeight - top - on.offsetHeight;
      const wasLeft = p.dataset.left === undefined ? null : Number(p.dataset.left);
      const wasTop = p.dataset.top === undefined ? null : Number(p.dataset.top);
      const first = wasLeft === null || wasTop === null || p.style.visibility === "hidden";
      let dir = "";
      if (slide && !first) {
        const dx = left - (wasLeft ?? left);
        const dy = top - (wasTop ?? top);
        dir = Math.abs(dy) > Math.abs(dx) ? (dy > 0 ? "down" : "up") : dx > 0 ? "right" : dx < 0 ? "left" : "";
      }
      p.dataset.dir = dir;
      if (!slide || first) p.dataset.still = "";
      p.style.left = `${left}px`;
      p.style.right = `${right}px`;
      p.style.top = `${top}px`;
      p.style.bottom = `${bottom}px`;
      // The copy moves against the pill on the same curve: it stays where the row is.
      copy.style.left = `${-left}px`;
      copy.style.top = `${-top}px`;
      fill(el, p, copy);
      p.style.visibility = "";
      p.dataset.left = String(left);
      p.dataset.top = String(top);
      if (p.dataset.still !== undefined) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => delete p.dataset.still);
        });
      }
    };
    place(true);
    // The words change width (a narrow window shows only the chosen one's, a font arrives):
    // the pill follows at once. An observer reports once as it starts; only a real change counts.
    let size = `${el.clientWidth}x${el.clientHeight}`;
    const resized = new ResizeObserver(() => {
      const now = `${el.clientWidth}x${el.clientHeight}`;
      if (now === size) return;
      size = now;
      place(false);
    });
    resized.observe(el);
    // Words that change (a count) are copied again. The copy's own changes are not news.
    const changed = new MutationObserver((records) => {
      if (records.some((r) => !p.contains(r.target))) fill(el, p, copy);
    });
    changed.observe(el, { childList: true, characterData: true, subtree: true });
    return () => {
      resized.disconnect();
      changed.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [row, pill, chosen, value]);
}
