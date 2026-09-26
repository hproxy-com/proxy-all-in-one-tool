import type { JSX } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMobile, isTauri } from "../lib/tauri";
import UpdatePanel from "./UpdatePanel";
import Wordmark from "./Wordmark";
import { Icon, cx } from "./ui";

export type View = "checker" | "connect" | "history" | "ai" | "settings";

/* Every screen is a tab at the top, Use with AI and Settings included, so
   nothing hides inside Settings. Using it from an AI is
   a computer thing (an assistant starts the command-line tool), so a phone
   does not get that tab. */
const NAV: { id: View; label: string; icon: (p: { className?: string }) => JSX.Element; desktopOnly?: boolean }[] = [
  { id: "connect", label: "Connect", icon: Icon.connect },
  { id: "checker", label: "Check", icon: Icon.listCheck },
  { id: "history", label: "History", icon: Icon.clock },
  { id: "ai", label: "Use with AI", icon: Icon.spark, desktopOnly: true },
  { id: "settings", label: "Settings", icon: Icon.settings },
];

const ctrl = (fn: () => Promise<unknown>) => () => {
  void fn().catch(() => {});
};

/**
 * Custom window chrome (the app runs frameless, decorations off), in look D
 * (a navigation bar along the top). The bar is a drag
 * region in the page colour: the H and "Proxy", every screen in one cut track
 * with the current one lit blue, then on the right the white/dark switch and
 * the window controls at full bar height, drawn the way Windows 11 draws them.
 * On a phone the tabs keep their icons and only the current one its word.
 */
export default function TitleBar({
  view,
  setView,
  theme,
  toggleTheme,
}: {
  view: View;
  setView: (v: View) => void;
  theme: "electric" | "midnight";
  toggleTheme: () => void;
}) {
  const dark = theme === "midnight";
  return (
    <div data-tauri-drag-region className="flex h-[50px] shrink-0 select-none items-center gap-4 bg-canvas pl-[18px] max-sm:gap-2 max-sm:pl-2.5">
      {/* On a phone the views are the whole width; the word goes, the views stay. */}
      <Wordmark className="text-[17px] max-sm:hidden" gid="title-mark" />

      <nav className="ux-navseg" aria-label="Screens">
        {NAV.filter((t) => !(t.desktopOnly && isMobile())).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setView(t.id)}
            title={t.label}
            aria-label={t.label}
            aria-current={view === t.id ? "page" : undefined}
            className={cx("ux-tab", view === t.id && "is-active")}
          >
            <t.icon />
            <span className="label">{t.label}</span>
          </button>
        ))}
      </nav>

      <div className="ml-auto flex h-full items-center gap-1.5">
        {/* Renders nothing unless an update is downloaded and ready. */}
        <UpdatePanel />
        <button
          type="button"
          onClick={toggleTheme}
          title={dark ? "White mode" : "Dark mode"}
          aria-label={dark ? "Switch to white mode" : "Switch to dark mode"}
          className="ux-iconbtn"
        >
          {dark ? <Icon.sun className="h-[17px] w-[17px]" /> : <Icon.moon className="h-[17px] w-[17px]" />}
        </button>

        {isTauri() && !isMobile() && (
          <div className="ml-2.5 flex h-full">
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
