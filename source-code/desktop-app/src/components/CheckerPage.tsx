import { useEffect, useMemo, useState } from "react";
import type { Settings } from "../lib/settings";
import { isMobile } from "../lib/tauri";
import CheckerConsole from "./checker/CheckerConsole";
import { useConnection } from "./connect/connection";
import History from "./History";
import { pushPage, usePhoneSub } from "./phone/PhoneShell";
import { cx } from "./ui";

/* The Checker: a page of its own again since 2026-10-12, beside Proxies in the
   title bar: the proxies and the checker are two pages. From 2026-09-30
   it was the fourth part of the Proxies page. Its History is inside it (the
   button beside the box). App.tsx keeps this page alive behind the others, so a
   run goes on while you look at your proxies, and "Check them" anywhere in the
   app (a group, a pasted list) lands here with the lines in the box
   (connection.tsx checkLines). On a phone it is a tab along the bottom and its
   History a step deeper, with the way back in the top bar. */

export default function CheckerPage({ settings, active }: { settings: Settings; active: boolean }) {
  const { checkSeed, connectThrough, saveAsGroup, destinations } = useConnection();
  // The names given in My proxies, by host:port: a checked proxy you named shows its name first.
  const names = useMemo(
    () => new Map(destinations.proxies.filter((p) => p.name).map((p) => [p.address, p.name as string])),
    [destinations.proxies],
  );
  const [history, setHistory] = useState(false);
  const phone = isMobile();
  // Coming back to the Checker opens the box, as its tab always did.
  useEffect(() => {
    if (active) setHistory(false);
  }, [active]);
  usePhoneSub(active && history ? { title: "History", back: () => setHistory(false) } : null);

  return (
    // The room above it matches Proxies': the title bar's tabs hang into the page's top.
    <div className={cx("relative flex h-full flex-col", !phone && "pt-4")}>
      {/* Alive behind History and the other pages: a check keeps running. */}
      <div className={cx(history ? "hidden" : "min-h-0 flex-1")}>
        <CheckerConsole
          active={active && !history}
          settings={settings}
          onConnect={connectThrough}
          onSaveGroup={saveAsGroup}
          seed={checkSeed}
          onHistory={() => (phone ? pushPage(() => setHistory(true)) : setHistory(true))}
          names={names}
        />
      </div>
      {/* On a phone the way back is the top bar's arrow and Back. */}
      {history && (
        <div className="min-h-0 flex-1">
          <History onBack={phone ? undefined : () => setHistory(false)} />
        </div>
      )}
    </div>
  );
}
