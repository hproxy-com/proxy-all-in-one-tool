/* The phone's pages (components/phone/PhoneShell.tsx): four tabs along the
   bottom, how one page gives way to the next, and the room the phone's own
   bars take.

   A phone gets its own frame around the same pages. The computer keeps its
   title bar with the pages along the top (TitleBar.tsx), and its look stays
   as it is.

   The Checker is a tab of its own here, where the computer keeps it inside
   Proxies: on a phone four sub-tabs do not fit in a row, and the app is
   named after the checker. Both frames share one model, the view and the
   Proxies pane (connect/connection.tsx), so everything that opens the
   checker (a list pasted on Connect, "Check them" in a group) lands on the
   Checker tab by itself. */

import type { View } from "../components/TitleBar";
import { phoneInsets } from "./tauri";

export type PhoneTab = "connect" | "proxies" | "checker" | "settings";

/** Left to right, as the bar shows them. */
export const PHONE_TABS: readonly PhoneTab[] = ["connect", "proxies", "checker", "settings"];

/** The tab a view belongs to (every part of Proxies is the Proxies tab). Use
    with AI is a computer's page and never opens on a phone; it would show as
    Connect. */
export function phoneTab(view: View): PhoneTab {
  if (view === "proxies") return "proxies";
  if (view === "checker") return "checker";
  if (view === "settings") return "settings";
  return "connect";
}

/** How a page gives way to the next:
      next, prev   to a tab right or left of this one: the new page comes in
                   from its tab's side
      push, pop    a step deeper (a section of Settings) and back out of it */
export type Move = "next" | "prev" | "push" | "pop";

export function tabMove(from: PhoneTab, to: PhoneTab): Move {
  return PHONE_TABS.indexOf(to) > PHONE_TABS.indexOf(from) ? "next" : "prev";
}

type ViewTransition = { finished: Promise<void> };
type WithTransitions = Document & { startViewTransition?: (update: () => void) => ViewTransition };

/** Change the page with its move: the browser keeps a picture of the page
    as it was, `update` changes it (synchronously: wrap React state in
    flushSync), and styles/phone.css slides the two. Where the browser has no
    view transitions, or the phone asks for less motion, the page changes at
    once. */
export function movePage(move: Move, update: () => void): void {
  const doc = document as WithTransitions;
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!doc.startViewTransition || still) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.move = move;
  const done = () => {
    if (root.dataset.move === move) delete root.dataset.move;
  };
  try {
    doc.startViewTransition(update).finished.then(done, done);
  } catch {
    done();
    update();
  }
}

/** "rgb(12, 12, 15)" as "#0c0c0f"; anything else as "". */
export function hexOf(css: string): string {
  const m = css.match(/^rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
  if (!m) return "";
  if (m[4] !== undefined && m[4] !== "1" && m[4] !== "100%") return "";
  const hex = [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"));
  return `#${hex.join("")}`;
}

/** The room the system bars take, as the phone measures it, in
    --inset-top/right/bottom/left. styles/phone.css takes the larger of these
    and the browser's own env(safe-area-inset-*): an older web view on a
    phone that draws edge to edge can report 0 there, and the status bar
    would sit on the page. Measured again when the window changes size (a
    turn, a switch between gestures and buttons). */
export function followInsets(): void {
  const apply = () =>
    void phoneInsets()
      .then((i) => {
        if (!i) return;
        const s = document.documentElement.style;
        s.setProperty("--inset-top", `${i.top}px`);
        s.setProperty("--inset-right", `${i.right}px`);
        s.setProperty("--inset-bottom", `${i.bottom}px`);
        s.setProperty("--inset-left", `${i.left}px`);
      })
      .catch(() => {});
  apply();
  let frame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(apply);
  });
}
