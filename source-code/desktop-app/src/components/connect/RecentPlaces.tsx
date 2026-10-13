import { useEffect } from "react";
import { aboutWords, groupWords, listLines, proxyTitle } from "../../lib/connect";
import { lastCheckWords, quickPlaces, type Place } from "../../lib/places";
import { pasteOneHere } from "../../lib/proxyExamples";
import { isMobile } from "../../lib/tauri";
import { BlockTitle, Flag, Icon } from "../ui";
import { useConnection } from "./connection";
import { LineField, rowProblem, rowState } from "./Destinations";
import PlaceRow from "./PlaceRow";

/* Quick connect, beside the connection on Connect: your places one click from
   connecting, the way a VPN app keeps its locations on its main screen. The
   places used last come first, then proxies saved but not used yet, so a
   proxy pasted a moment ago is right there (lib/places.ts quickPlaces, the
   same rule as the tray's menu). The fastest free proxy is always the last
   row. The paste field is always here (first while you have no places, under
   them after): paste a proxy and its Connect, or Enter, connects through it
   and keeps it in My proxies. A proxy pasted anywhere on Connect lands in it
   (connection.tsx, quickAsk). The rows are the Proxies page's own
   (PlaceRow.tsx); everything else about places is on that page. */

/** How many of your places show. */
const SHOWN = 5;

export default function RecentPlaces() {
  const { destinations: d, open, quickRef, quickAsk, takePasted } = useConnection();
  // Asked for a moment ago (a proxy pasted on Connect, the switch with nothing picked):
  // the field takes the keyboard, so the next Ctrl+V or Enter needs no click.
  useEffect(() => {
    if (quickAsk && Date.now() - quickAsk < 1500) quickRef.current?.focus({ preventScroll: true });
  }, [quickAsk, quickRef]);
  const places = quickPlaces(d.proxies, d.groups, SHOWN);
  // Nothing of your own (yet, or not read yet): the field comes first.
  const empty = d.proxies.length === 0 && d.groups.length === 0;
  // The pool's fastest exit, on the protocol the Free tab was last left on.
  const fastest: Place = { kind: "free", country: "", socks5: d.freeSocks5 };
  // A whole list pasted into the field is reviewed on the Proxies page, line by line.
  const takeList = (text: string): boolean => {
    if (listLines(text).length < 2) return false;
    takePasted(text);
    return true;
  };

  const field = (placeholder: string) => (
    <div className="ux-addbox">
      <LineField p={d} inputRef={quickRef} solid connect placeholder={placeholder} onMany={takeList} />
    </div>
  );

  return (
    <div className="ux-panel ux-recent flex flex-col gap-3 p-5 max-sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <BlockTitle name="Quick connect" />
        <button type="button" className="ux-link" onClick={() => open("proxies")}>
          All proxies <Icon.arrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
      {empty && field(pasteOneHere(isMobile()))}
      <div className="ux-places -mx-2" role="list" aria-label="Quick connect">
        {places.map((q) => {
          if (q.kind === "group") {
            const place: Place = { kind: "group", id: q.group.id };
            return (
              <PlaceRow
                key={q.group.id}
                lead={<Icon.layers />}
                name={q.group.name}
                sub={groupWords(q.group)}
                state={rowState(place, d)}
                running={d.running}
                busy={d.busy}
                problem={rowProblem(place, d)}
                onConnect={() => d.onConnect(place)}
              />
            );
          }
          const s = q.proxy;
          const place: Place = { kind: "proxy", id: s.id };
          // What the line is (a session in California); else, under a name, its address.
          const said = lastCheckWords(s.last);
          const sub = [aboutWords(s.about) || (s.name ? s.address : undefined), said ? said.text : s.last?.place]
            .filter(Boolean)
            .join(" · ");
          const cc = s.last?.cc ?? s.about?.country?.toLowerCase();
          return (
            <PlaceRow
              key={s.id}
              lead={cc ? <Flag cc={cc} /> : <Icon.globe />}
              name={proxyTitle(s)}
              mono={!s.name}
              sub={sub || undefined}
              ms={s.last?.ok ? (s.last.latencyMs ?? null) : null}
              state={rowState(place, d)}
              running={d.running}
              busy={d.busy}
              problem={rowProblem(place, d)}
              onConnect={() => d.onConnect(place)}
            />
          );
        })}
        <PlaceRow
          key="fastest-free"
          lead={<Icon.bolt />}
          name="Fastest free proxy"
          state={rowState(fastest, d)}
          running={d.running}
          busy={d.busy}
          problem={rowProblem(fastest, d)}
          tooltip="A public proxy, the quickest from here, swapped when it stops. Never log in or pay through one."
          onConnect={() => d.onConnect(fastest)}
        />
      </div>
      {!empty && field("Paste another proxy")}
    </div>
  );
}
