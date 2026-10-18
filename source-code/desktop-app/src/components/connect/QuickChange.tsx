import { useEffect, useState } from "react";
import { aboutWords, groupWords, proxyTitle, spacedN } from "../../lib/connect";
import { changePlaces, lastCheckWords, placeOfChange, samePlace, tabOf, type ChangePlace } from "../../lib/places";
import { Flag, Icon, cx } from "../ui";
import { useConnection } from "./connection";
import { rowProblem, rowState } from "./Destinations";
import PlaceRow from "./PlaceRow";

/* Quick change (2026-10-18: "the blue button when you press change should let you quick change it
   or view the full list"): Change on Connect opens the places to switch to without leaving the
   page. The one in use comes first, whatever its speed, so it is always in sight and marked; then
   your proxies that answered their last check, the fastest first; then the rest Quick connect
   would show (lib/places.ts changePlaces). A click connects there, or moves there while
   connected, as every row in the app does. "View the full list" is the Proxies page, on the tab
   of the place in use. The Mix look shows it in its sheet (mix/MixConnect.tsx), the other
   looks under their Change (ConnectionCard.tsx, TargetRow). */

/** How many places it offers. */
const SHOWN = 5;

/** The places Change offers and the words above them. */
export function useChangeList() {
  const { destinations: d, chosen } = useConnection();
  // The one in use: a connect under way, else the one the relay goes through, else the one the
  // switch connects to.
  const current = d.goingTo ?? (d.running ? d.connected : null) ?? chosen;
  const { places, working } = changePlaces(d.proxies, d.groups, current, SHOWN);
  const line = working
    ? `${working === 1 ? "1 works" : `${spacedN(working)} work`}, the fastest first`
    : d.proxies.length
      ? "None checked yet: Test all is on the full list"
      : "";
  // The full list's count: the tab it opens on.
  const tab = tabOf(current);
  const total = tab === "groups" ? d.groups.length : tab === "proxies" ? d.proxies.length : 0;
  return { current, places, line, total };
}

/** The rows and the way to the full list. `onDone`: a row or the full list was taken. */
export function ChangeRows({ list, onDone }: { list: ReturnType<typeof useChangeList>; onDone: () => void }) {
  const { destinations: d, card } = useConnection();
  const row = (c: ChangePlace) => {
    const place = placeOfChange(c);
    const marked = !d.running && !d.goingTo && samePlace(place, list.current);
    const common = {
      state: rowState(place, d),
      running: d.running,
      busy: d.busy,
      problem: rowProblem(place, d),
      chosen: marked,
      onConnect: () => {
        d.onConnect(place);
        onDone();
      },
    };
    if (c.kind === "group") {
      return <PlaceRow key={`g-${c.group.id}`} lead={<Icon.layers />} name={c.group.name} sub={groupWords(c.group)} {...common} />;
    }
    if (c.kind === "free") {
      return (
        <PlaceRow
          key="free"
          lead={<Icon.bolt />}
          name={card.view?.kind === "free" ? card.view.name : "Free proxy"}
          sub={card.view?.kind === "free" ? card.view.sub : undefined}
          {...common}
        />
      );
    }
    const s = c.proxy;
    // As Quick connect says it: what the line is, else under a name its address; then its place.
    const said = lastCheckWords(s.last);
    const sub = [aboutWords(s.about) || (s.name ? s.address : undefined), said ? said.text : s.last?.place].filter(Boolean).join(" · ");
    const cc = s.last?.cc ?? s.about?.country?.toLowerCase();
    return (
      <PlaceRow
        key={s.id}
        lead={cc ? <Flag cc={cc} /> : <Icon.globe />}
        name={proxyTitle(s)}
        mono={!s.name}
        sub={sub || undefined}
        ms={s.last?.ok ? (s.last.latencyMs ?? null) : null}
        {...common}
      />
    );
  };
  return (
    <>
      <div className="ux-places" role="list" aria-label="Quick change">
        {list.places.map(row)}
      </div>
      <button
        type="button"
        className="ux-qc-full"
        onClick={() => {
          card.onChangeTarget();
          onDone();
        }}
      >
        View the full list{list.total ? ` (${spacedN(list.total)})` : ""}
      </button>
    </>
  );
}

/** Change, for the looks with a Change link: the link, and Quick change under it. */
export function ChangeButton() {
  const [open, setOpen] = useState(false);
  const list = useChangeList();
  useEffect(() => {
    if (!open) return;
    // Caught on the way down, so the page's own Escape (which stops a check) never hears it.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open]);
  return (
    <span className="relative">
      <button type="button" className="ux-link" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        Change <Icon.chevronDown className={cx("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div role="dialog" aria-label="Quick change" className="ux-float ux-qc rise-in absolute right-0 top-full z-50 mt-2">
            <div className="ux-qc-head">
              <b>Quick change</b>
              {list.line && <small>{list.line}</small>}
            </div>
            <ChangeRows list={list} onDone={() => setOpen(false)} />
          </div>
        </>
      )}
    </span>
  );
}
