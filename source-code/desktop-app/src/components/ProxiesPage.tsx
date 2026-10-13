import { useLayoutEffect, useRef } from "react";
import { slideIn } from "../lib/motion";
import { isMobile } from "../lib/tauri";
import Destinations from "./connect/Destinations";
import { useConnection, type ProxiesPane } from "./connect/connection";
import { Icon, useCrossbar } from "./ui";

/* Proxies: every place to connect through, in three parts: My proxies, Groups
   and Free. The places are the same list Connect used to carry
   (Destinations.tsx), fed by the connection above both pages
   (connect/connection.tsx). App.tsx keeps this page alive behind the others.

   Since 2026-10-02 "My lists" is Groups. From 2026-09-30 the checker was a
   fourth part here; since 2026-10-12 it is a page of its own again
   (CheckerPage.tsx).

   The parts, since 2026-10-12 (the second row of pills inside the page is gone):
   the title bar's tabs, hanging from the top, are the pages; a page's own parts
   are its words on a hairline, the current one in ink with the H's crossbar
   under it, which slides to the next (ui/crossbar.ts, styles/pages.css
   .ux-pagetabs; the Checker's Working / Not working / All is the same). Until
   then they were a second track of pills, like the title bar's. A new part
   comes in from its tab's side (lib/motion.ts). */

const PANES: readonly { id: ProxiesPane; name: string }[] = [
  { id: "proxies", name: "My proxies" },
  { id: "groups", name: "Groups" },
  { id: "free", name: "Free" },
];

export default function ProxiesPage({ active }: { active: boolean }) {
  const { destinations, pane, setPane, drag } = useConnection();
  const phone = isMobile();
  const count = (id: ProxiesPane) => (id === "proxies" ? destinations.proxies.length : id === "groups" ? destinations.groups.length : 0);

  const row = useRef<HTMLElement>(null);
  const bar = useRef<HTMLElement>(null);
  useCrossbar(row, bar, pane);
  // A computer: a new part comes in from its tab's side, while this page is showing.
  const body = useRef<HTMLDivElement>(null);
  const shown = useRef({ pane, active });
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { pane, active };
    if (phone || before.pane === pane || !before.active || !active) return;
    const at = (id: ProxiesPane) => PANES.findIndex((p) => p.id === id);
    slideIn(body.current, at(pane) > at(before.pane) ? "right" : "left");
  }, [pane, active, phone]);

  return (
    <div className="relative flex h-full flex-col" onDragOver={drag.onDragOver} onDragLeave={drag.onDragLeave} onDrop={drag.onDrop}>
      <div className="mx-auto w-full max-w-[1180px] px-6 pt-4 max-sm:px-3">
        <nav ref={row} className="ux-pagetabs" aria-label="Proxies">
          {PANES.map((p) => (
            <button key={p.id} type="button" aria-current={pane === p.id ? "page" : undefined} onClick={() => setPane(p.id)}>
              {p.name}
              {count(p.id) > 0 && <span className="count num">{count(p.id)}</span>}
            </button>
          ))}
          <i ref={bar} className="ux-pagetabs-bar" aria-hidden="true" />
        </nav>
      </div>

      <div ref={body} className="min-h-0 flex-1">
        <div className="h-full overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-[1180px] px-6 pb-8 pt-5 max-sm:px-3">
            <Destinations {...destinations} hideHeader />
          </div>
        </div>
      </div>

      {drag.active && (
        <div className="drop-veil" aria-hidden="true">
          <span>
            <Icon.drop className="h-7 w-7" />
            Drop your proxies
          </span>
        </div>
      )}
    </div>
  );
}
