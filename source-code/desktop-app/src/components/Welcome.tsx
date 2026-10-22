import { useEffect, type JSX } from "react";
import { useConnection, type ProxiesPane } from "./connect/connection";
import type { View } from "./TitleBar";
import { Button, Icon } from "./ui";

/* The first start (since 2026-10-22: most new copies came from a store's own search, with no
   proxies yet). Three ways to start, asked once: I have proxies (My proxies and its box), Try a free
   proxy (the Free tab, where they pick one themselves: the switch still never picks a free proxy by
   itself), Check a list (the Checker). Skip or Escape closes it. Only a new copy is asked
   (lib/settings.ts, `welcomed`). */

type Way = { title: string; words: string; icon: (p: { className?: string }) => JSX.Element; view: View; pane?: ProxiesPane };

const WAYS: readonly Way[] = [
  {
    title: "I have proxies",
    words: "Paste them, drop a file or type one. Each is tested before it's kept.",
    icon: Icon.key,
    view: "proxies",
    pane: "proxies",
  },
  {
    title: "Try a free proxy",
    words: "Public proxies by country, tested first. Fine for a look, never for logins.",
    icon: Icon.globe,
    view: "proxies",
    pane: "free",
  },
  {
    title: "Check a list",
    words: "Which proxies work, how fast, where they come out and how risky they look.",
    icon: Icon.listCheck,
    view: "checker",
  },
];

export default function Welcome({ setView, onDone }: { setView: (v: View) => void; onDone: () => void }) {
  const { setPane } = useConnection();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onDone]);
  const go = (way: Way) => {
    if (way.pane) setPane(way.pane);
    setView(way.view);
    onDone();
  };
  return (
    <>
      <div className="ux-dialog-scrim" data-scrim="true" />
      <div className="ux-dialog ux-welcome rise-in" role="dialog" aria-modal="true" aria-label="Welcome to HProxy">
        <b className="text-[24px] font-extrabold tracking-[-0.02em] text-ink">Welcome to HProxy</b>
        <p className="text-[14.5px] font-medium text-ink-mute">How do you want to start?</p>
        <div className="ux-welcome-ways">
          {WAYS.map((way) => (
            <button key={way.title} type="button" className="ux-welcome-way" onClick={() => go(way)}>
              <way.icon className="lead" />
              <span className="words">
                <b>{way.title}</b>
                <span>{way.words}</span>
              </span>
              <Icon.chevronRight className="go" />
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <Button variant="text" onClick={onDone} title="Escape">
            Skip
          </Button>
        </div>
      </div>
    </>
  );
}
