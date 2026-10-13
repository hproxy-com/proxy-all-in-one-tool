import { useLayoutEffect, useRef, useState, type JSX, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../lib/tauri";
import IpPill from "./IpPill";
import UpdatePanel from "./UpdatePanel";
import Wordmark from "./Wordmark";
import { Icon, cx, useSlidingPill } from "./ui";

/** The pages. The checker (its History inside it) is a page of its own again since
    2026-10-12, beside Proxies. */
export type View = "connect" | "proxies" | "checker" | "ai" | "settings";

/* Every screen is a tab in the middle, Settings included (2026-10-12). Five
   tabs with room around each fit a 1280 px window beside the address with short
   words: "AI" on the tab, "Use with AI" on its page. Using it from an AI is a
   computer thing (an assistant starts the command-line tool): a phone has no
   such tab. */
const NAV: { id: View; label: string; title: string; icon: (p: { className?: string }) => JSX.Element }[] = [
  { id: "connect", label: "Connect", title: "Connect", icon: Icon.connect },
  { id: "proxies", label: "Proxies", title: "Proxies", icon: Icon.layers },
  { id: "checker", label: "Checker", title: "Checker", icon: Icon.listCheck },
  { id: "ai", label: "AI", title: "Use with AI", icon: Icon.spark },
  { id: "settings", label: "Settings", title: "Settings", icon: Icon.settings },
];

const ctrl = (fn: () => Promise<unknown>) => () => {
  void fn().catch(() => {});
};

/** How much of the address fits on the right: all of it, all but the city, or none. */
type AddressFit = "whole" | "short" | "none";

/* Short of room on the right (a narrower window, a long address, an update
   waiting), the city is set aside first and then the whole pill: never cut,
   never squeezing the tabs (2026-10-12). Measured, not guessed from the window's width:
   the room depends on the tabs, the address and whatever else this side
   holds. The pill never shrinks, and a city or pill set aside keeps its width
   (pages.css), so both widths are known whatever shows now. */
function useAddressFit(side: RefObject<HTMLElement | null>): AddressFit {
  const [fit, setFit] = useState<AddressFit>("whole");
  useLayoutEffect(() => {
    const el = side.current;
    if (!el) return;
    let frame = 0;
    const width = (e: Element) => e.getBoundingClientRect().width;
    const measure = () => {
      const pill = el.querySelector<HTMLElement>(".ux-ippill");
      if (!pill) return;
      const css = getComputedStyle(el);
      const gap = parseFloat(css.columnGap) || 0;
      // The room: this side inside its padding, less everything else on it, each with its margins and a gap.
      let room = width(el) - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0);
      for (const c of el.children) {
        if (c === pill || width(c) === 0) continue;
        const m = getComputedStyle(c);
        room -= width(c) + parseFloat(m.marginLeft) + parseFloat(m.marginRight) + gap;
      }
      const where = pill.querySelector<HTMLElement>(".where");
      const city = where ? width(where) + (parseFloat(getComputedStyle(where.parentElement ?? where).columnGap) || 0) : 0;
      const cityShown = where != null && getComputedStyle(where).position !== "absolute";
      const whole = width(pill) + (cityShown ? 0 : city);
      const next: AddressFit = whole <= room + 0.5 ? "whole" : whole - city <= room + 0.5 ? "short" : "none";
      setFit(next);
    };
    // After the frame's layout, never inside the observer's own report.
    const soon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resized = new ResizeObserver(soon);
    const watch = () => {
      resized.disconnect();
      resized.observe(el);
      for (const c of el.children) resized.observe(c);
      const where = el.querySelector(".ux-ippill .where");
      if (where) resized.observe(where);
    };
    // A new state in the pill (keyed, so new elements) or an update appearing.
    const changed = new MutationObserver(() => {
      watch();
      soon();
    });
    changed.observe(el, { childList: true, subtree: true });
    watch();
    measure();
    return () => {
      resized.disconnect();
      changed.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [side]);
  return fit;
}

/**
 * Custom window chrome (the app runs frameless, decorations off), in look D
 * (a navigation bar along the top). The bar is a drag region in the page
 * colour, in three columns: the H and "Proxy" alone on the left; every screen
 * in one cut track in the exact middle of the window, hanging from its top
 * edge with big tabs (2026-10-12), with one solid blue pill under the current
 * one that slides to the next (ui/slidingPill.ts);
 * on the right the address you appear as and the window controls, drawn the
 * way Windows 11 draws them. White or dark lives in Settings (the switch that
 * stood beside the H is gone), and the logo grew. The two sides keep a 56 px
 * row and are equal, so
 * the track stays centred; short of room the address drops its city, then
 * leaves the bar, and the tabs keep their words (globals.css, "The tabs hang
 * from the top"). A computer's only: a phone has its own frame, with the tabs
 * along the bottom (phone/PhoneShell.tsx).
 */
export default function TitleBar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const row = useRef<HTMLElement>(null);
  const pill = useRef<HTMLElement>(null);
  const right = useRef<HTMLDivElement>(null);
  useSlidingPill(row, pill, ".ux-tab.is-active", view);
  const address = useAddressFit(right);
  return (
    <div
      data-tauri-drag-region
      className="ux-titlebar grid shrink-0 select-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3 bg-canvas"
    >
      {/* The side columns carry the drag region too: Tauri drags only from an element that has it.
          The left margin is inside this column, not on the bar, so both sides stay equal. Both
          sides keep a 56 px row, the tabs centred on it; the tabs hang lower (globals.css). */}
      <div data-tauri-drag-region className="flex h-[56px] min-w-0 items-center pl-5 max-sm:pl-2.5">
        {/* In a narrow window the views are the whole width; the word goes, the views stay. */}
        <Wordmark className="text-[20px] max-sm:hidden" gid="title-mark" />
      </div>

      <nav ref={row} className="ux-navseg" aria-label="Screens">
        <i ref={pill} className="ux-pill" aria-hidden="true" />
        {NAV.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setView(t.id)}
            title={t.title}
            aria-label={t.title}
            aria-current={view === t.id ? "page" : undefined}
            className={cx("ux-tab", view === t.id && "is-active")}
          >
            <t.icon />
            <span className="label">{t.label}</span>
          </button>
        ))}
      </nav>

      {/* min-w-0: short of room, this side gives way (useAddressFit above, pages.css). pl-3: with
          the bar's own gap, the address keeps 24 px from the tabs. A browser draws no window
          buttons, so there the address keeps off the edge as the H does on the left (pr-5); in
          the app the buttons sit flush with the edge, the way Windows draws them. */}
      <div
        ref={right}
        data-tauri-drag-region
        data-address={address}
        className={cx("ux-titleright flex h-[56px] min-w-0 items-center justify-end gap-1.5 pl-3", !isTauri() && "pr-5")}
      >
        <IpPill onOpen={() => setView("connect")} />
        {/* Renders nothing unless an update is downloaded and ready. */}
        <UpdatePanel />

        {/* Straight after the address: the glyphs sit in the middle of 46 px buttons, so it
            already keeps about 23 px from the first one. */}
        {isTauri() && (
          <div className="flex h-full">
            <button type="button" onClick={ctrl(() => getCurrentWindow().minimize())} title="Minimize" className="ux-winbtn">
              <svg viewBox="0 0 12 12" className="h-[11px] w-[11px]" aria-hidden="true">
                <path d="M1 6h10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button type="button" onClick={ctrl(() => getCurrentWindow().toggleMaximize())} title="Maximize" className="ux-winbtn">
              <svg viewBox="0 0 12 12" className="h-[11px] w-[11px]" aria-hidden="true">
                <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button type="button" onClick={ctrl(() => getCurrentWindow().close())} title="Close" className="ux-winbtn ux-winbtn--close">
              <svg viewBox="0 0 12 12" className="h-[11px] w-[11px]" aria-hidden="true">
                <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
