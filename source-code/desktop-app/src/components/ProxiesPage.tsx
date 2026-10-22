import { useLayoutEffect, useRef, type JSX } from "react";
import { askProxies } from "../lib/proxiesAsk";
import { slideIn } from "../lib/motion";
import { isMobile } from "../lib/tauri";
import Destinations from "./connect/Destinations";
import { useConnection, type ProxiesPane } from "./connect/connection";
import { Icon } from "./ui";

/* Proxies: every place to connect through, in three parts: My proxies, Groups
   and Free. The places are the same list Connect used to carry
   (Destinations.tsx), fed by the connection above both pages
   (connect/connection.tsx). App.tsx keeps this page alive behind the others.

   Since 2026-10-02 "My lists" is Groups. From 2026-09-30 the checker was a
   fourth part here; since 2026-10-12 it is a page of its own again
   (CheckerPage.tsx).

   The parts, since 2026-10-22: three cards at the page's head, the one shown
   in solid blue, each saying what it holds. On My proxies the head's right
   holds Add and the big blue "Paste what I copied".
   Until then the parts were words on a hairline with the H's crossbar under
   the current one (2026-10-12; the Checker's Working / Not working / All
   still are), and before that a second track of pills. A new part comes in
   from its card's side (lib/motion.ts). */

const PANES: readonly { id: ProxiesPane; name: string; icon: (p: { className?: string }) => JSX.Element }[] = [
  { id: "proxies", name: "My proxies", icon: Icon.key },
  { id: "groups", name: "Groups", icon: Icon.layers },
  { id: "free", name: "Free", icon: Icon.globe },
];

/** The head's right on My proxies: Add opens the box, Paste what I copied takes the clipboard
    straight to its test (Destinations.tsx listens, lib/proxiesAsk.ts). */
function PageActions() {
  return (
    <div className="ux-pageactions">
      <button type="button" className="ux-add-way" onClick={() => askProxies("add")} title="Type or paste them, or drop a file">
        <Icon.plus />
        Add
      </button>
      <button type="button" className="ux-add-way is-main" onClick={() => askProxies("paste")} title="What you copied: one proxy or a whole list">
        <Icon.clipboard />
        Paste what I copied
      </button>
    </div>
  );
}

export default function ProxiesPage({ active }: { active: boolean }) {
  const { destinations, pane, setPane, drag } = useConnection();
  const phone = isMobile();
  const actions = pane === "proxies";
  /** What a card says it holds. */
  const holds = (id: ProxiesPane) => {
    if (id === "free") return "Public, by country";
    const n = id === "groups" ? destinations.groups.length : destinations.proxies.length;
    return n ? `${n} saved` : "None yet";
  };

  // A computer: a new part comes in from its card's side, while this page is showing.
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
        <div className="ux-pagehead">
          <nav className="ux-panecards" aria-label="Proxies">
            {PANES.map((p) => (
              <button key={p.id} type="button" aria-current={pane === p.id ? "page" : undefined} onClick={() => setPane(p.id)}>
                <p.icon className="icon" />
                <span className="words">
                  <b>{p.name}</b>
                  <span className="num">{holds(p.id)}</span>
                </span>
              </button>
            ))}
          </nav>
          {actions && <PageActions />}
        </div>
      </div>

      <div ref={body} className="min-h-0 flex-1">
        <div className="h-full overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-[1180px] px-6 pb-8 pt-5 max-sm:px-3">
            <Destinations {...destinations} hideHeader dragging={drag.active} />
          </div>
        </div>
      </div>

      {/* My proxies opens Add and its file side shows where the file goes (2026-10-22); the
          other parts keep the page's own word for it. */}
      {drag.active && pane !== "proxies" && (
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
