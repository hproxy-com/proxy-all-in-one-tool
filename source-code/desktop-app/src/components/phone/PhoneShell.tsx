import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { setPageBack, useBack } from "../../lib/back";
import { movePage, phoneTab, tabMove, type PhoneTab } from "../../lib/phone";
import { phoneBuzz, phoneToBackground } from "../../lib/tauri";
import { useConnection } from "../connect/connection";
import HLetter from "../HLetter";
import IpPill from "../IpPill";
import type { View } from "../TitleBar";
import { Icon } from "../ui";
import BottomNav, { TAB_NAMES } from "./BottomNav";

/* The phone's frame around the pages (lib/phone.ts says why a phone gets its
   own): along the top, the page's name and the address you appear as, under
   the status bar; along the bottom, the four tabs, over the gesture bar. The
   page draws under both of the phone's bars (MainActivity.kt) and leaves them
   their room here (styles/phone.css).

   Back (lib/back.ts): whatever is open first, then a step deeper, then back
   to Connect, and from Connect the app goes to the background with its
   connection running. */

type Sub = { title: string; back: () => void };

/** A step deeper on a phone page (a section of Settings, the Checker's
    History), for the top bar: its title and the way back out. */
const SubContext = createContext<((sub: Sub | null) => void) | null>(null);

/** Opens a step deeper while `sub` is given: the top bar shows its title
    with an arrow back, and Back leaves it. Does nothing on a computer. */
export function usePhoneSub(sub: { title: string; back: () => void } | null): void {
  const set = useContext(SubContext);
  const back = useRef(sub?.back);
  useEffect(() => {
    back.current = sub?.back;
  });
  const title = sub?.title ?? null;
  useEffect(() => {
    if (!set || title === null) return;
    set({ title, back: () => back.current?.() });
    return () => set(null);
  }, [set, title]);
  useBack(!!set && title !== null, () => leave(() => back.current?.()));
}

/** Into a step deeper, with the page sliding over from the right. */
export function pushPage(update: () => void): void {
  movePage("push", () => flushSync(update));
}

/** Back out of a step, the page sliding back to the right. */
function leave(update: () => void): void {
  movePage("pop", () => flushSync(update));
}

export default function PhoneShell({
  view,
  setView,
  theme,
  toggleTheme,
  children,
}: {
  view: View;
  setView: (v: View) => void;
  theme: "electric" | "midnight";
  toggleTheme: () => void;
  children: ReactNode;
}) {
  const { card, pane } = useConnection();
  const tab = phoneTab(view);
  const [sub, setSub] = useState<Sub | null>(null);
  const page = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);
  // For a moment after a page opens its rows rise in (styles/phone.css),
  // and only then: a list sorting itself later must not replay it.
  const [fresh, setFresh] = useState(true);
  const dark = theme === "midnight";

  // Proxies opens on the last kind of place shown (the pane stays as it was).
  const show = (to: PhoneTab) => setView(to);

  const go = (to: PhoneTab) => {
    if (to === tab) {
      // The tab you are on, again: back to the top of the page.
      page.current?.querySelectorAll<HTMLElement>("*").forEach((el) => {
        if (el.scrollTop > 0 && el.offsetParent !== null) el.scrollTo({ top: 0, behavior: "smooth" });
      });
      return;
    }
    void phoneBuzz("tick").catch(() => {});
    movePage(tabMove(tab, to), () => flushSync(() => show(to)));
  };

  // A new page starts at the top, without the line under the bar, its rows rising in.
  useEffect(() => {
    setScrolled(false);
    setFresh(true);
    const t = window.setTimeout(() => setFresh(false), 900);
    return () => window.clearTimeout(t);
  }, [tab, pane]);

  // Back with nothing open: to Connect, and from Connect to the background.
  const latest = useRef({ go, tab });
  useEffect(() => {
    latest.current = { go, tab };
  });
  useEffect(
    () =>
      setPageBack(() => {
        if (latest.current.tab !== "connect") latest.current.go("connect");
        else void phoneToBackground().catch(() => {});
      }),
    [],
  );

  // A buzz for the switch: pressed, connected, failed, and a connection
  // that stops answering.
  const phase = useRef(card.phase);
  useEffect(() => {
    const before = phase.current;
    phase.current = card.phase;
    if (before === card.phase) return;
    const now = card.phase;
    const buzz =
      (before === "off" && now === "connecting") || (before === "on" && now === "leaving")
        ? "press"
        : (before === "connecting" || before === "switching") && now === "on"
          ? "confirm"
          : before === "connecting" && now === "off"
            ? "reject"
            : null;
    if (buzz) void phoneBuzz(buzz).catch(() => {});
  }, [card.phase]);
  const failing = useRef(card.failing);
  useEffect(() => {
    if (card.failing && !failing.current) void phoneBuzz("reject").catch(() => {});
    failing.current = card.failing;
  }, [card.failing]);

  const title = sub ? sub.title : TAB_NAMES[tab];

  return (
    <SubContext.Provider value={setSub}>
      <div className="ux-phone bg-canvas text-ink">
        <header className="ux-phonebar" data-scrolled={scrolled || undefined}>
          {sub ? (
            <button type="button" className="ux-iconbtn ux-phoneback" aria-label="Back" title="Back" onClick={() => leave(sub.back)}>
              <Icon.arrowLeft className="h-[20px] w-[20px]" />
            </button>
          ) : (
            <HLetter fill="blue" gid="phone-mark" className="ux-phonemark" />
          )}
          <h1 key={title} className="title">
            {title}
          </h1>
          <IpPill onOpen={() => go("connect")} />
          <button
            type="button"
            onClick={toggleTheme}
            title={dark ? "White mode" : "Dark mode"}
            aria-label={dark ? "Switch to white mode" : "Switch to dark mode"}
            className="ux-iconbtn"
          >
            {dark ? <Icon.sun className="h-[18px] w-[18px]" /> : <Icon.moon className="h-[18px] w-[18px]" />}
          </button>
        </header>

        <main
          ref={page}
          className="ux-phonepage"
          data-fresh={fresh || undefined}
          onScrollCapture={(e) => {
            const el = e.target as HTMLElement;
            if (el.scrollHeight > el.clientHeight) setScrolled(el.scrollTop > 2);
          }}
        >
          {children}
        </main>

        <BottomNav tab={tab} onTab={go} />
      </div>
    </SubContext.Provider>
  );
}
