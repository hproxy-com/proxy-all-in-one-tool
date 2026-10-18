import { useEffect, useRef, useState, type ReactNode } from "react";
import { speedOf } from "../../lib/connect";
import { isMobile } from "../../lib/tauri";
import PhoneSheet, { SheetItem } from "../phone/PhoneSheet";
import { Icon, cx } from "../ui";

/* One row for every list of places: My proxies, My lists, the free countries
   and their tested proxies, and Recent on Connect (2026-09-30, after reading
   how seven proxy connectors build their lists).

   A click connects, or switches while connected, as in the common VPN and
   proxy apps, where this app used to make a click only pick the place. The row leads with a flag and a name, one small line
   under it, the speed on the right as three bars and the milliseconds, and
   everything else behind ⋯. The connected row says so and carries a bar of
   HProxy blue on its left. Hover shows a hairline and the word for the click;
   fills are solid (styles/pages.css, "Place rows"). */

export type RowState = "idle" | "connected" | "connecting";

export type RowMenuItem = { label: string; onClick: () => void; danger?: boolean };

export type PlaceRowProps = {
  lead: ReactNode;
  name: ReactNode;
  /** Addresses, in tabular figures. */
  mono?: boolean;
  sub?: ReactNode;
  /** The time the last test took, when there is one. */
  ms?: number | null;
  /** A test of this one is running. */
  checking?: boolean;
  /** Words on the right where a speed would be: "1,612 free". */
  aside?: ReactNode;
  /** A chip before the speed: how many days a place has left. */
  tag?: ReactNode;
  state?: RowState;
  /** The one the switch connects to while you are off (Quick change): a check on its right. */
  chosen?: boolean;
  /** "bad": a place that failed its test, its mark in red. */
  tone?: "bad";
  /** The relay runs through another place: the click word is "Switch here". */
  running: boolean;
  /** A connect or a stop is under way: a click waits for it. */
  busy?: boolean;
  /** Why the last connect through this place failed, under its name in red. */
  problem?: string | null;
  tooltip?: string;
  onConnect?: () => void;
  menu?: RowMenuItem[];
  /** ▸ at the end: the row opens to show more under it. */
  expand?: { open: boolean; onToggle: () => void; label: string };
  children?: ReactNode;
  /** In the name's place while the name is being edited. A field inside the
      row's button is not allowed, so the row is not a button meanwhile. */
  editing?: ReactNode;
  /** Under the row, while something about it is being edited (its name,
      last day and note). */
  below?: ReactNode;
};

export default function PlaceRow(p: PlaceRowProps) {
  const state = p.state ?? "idle";
  const on = state === "connected";
  const clickable = !!p.onConnect && !on && !p.busy && !p.editing;
  const body = (
    <>
      <span className="lead">{p.lead}</span>
      <span className="text">
        {p.editing ?? <span className={cx("name", p.mono && "num")}>{p.name}</span>}
        {p.problem ? <span className="sub is-bad">{p.problem}</span> : p.sub ? <span className="sub">{p.sub}</span> : null}
      </span>
      {on ? (
        <span className="state">
          <i aria-hidden="true" />
          Connected
        </span>
      ) : state === "connecting" ? (
        <span className="word is-busy">Connecting…</span>
      ) : (
        p.onConnect && !p.editing && <span className="word">{p.running ? "Switch here" : "Connect"}</span>
      )}
      {p.chosen && !on && state !== "connecting" && (
        <span className="chosen" title="The switch connects this one">
          <Icon.check />
        </span>
      )}
      {p.tag != null && <span className="tag">{p.tag}</span>}
      {p.checking ? (
        <span className="speed num is-checking">Checking…</span>
      ) : p.ms != null ? (
        <Speed ms={p.ms} />
      ) : p.tag != null ? (
        // No speed to show: its room stays, so every row's chip stands in one column.
        <span className="speed" aria-hidden="true" />
      ) : null}
      {p.aside != null && <span className="aside num">{p.aside}</span>}
    </>
  );
  return (
    <div
      role="listitem"
      className={cx("ux-place", on && "is-on", state === "connecting" && "is-connecting", p.expand?.open && "is-open", p.tone === "bad" && "is-bad")}
    >
      <div className="line">
        {p.editing ? (
          <div className="main">{body}</div>
        ) : (
          <button
            type="button"
            className="main"
            onClick={clickable ? p.onConnect : undefined}
            aria-disabled={clickable ? undefined : true}
            title={p.tooltip}
          >
            {body}
          </button>
        )}
        {p.expand && (
          <button
            type="button"
            className="ux-iconbtn expand"
            aria-expanded={p.expand.open}
            aria-label={p.expand.label}
            title={p.expand.label}
            onClick={p.expand.onToggle}
          >
            <Icon.chevronRight />
          </button>
        )}
        {p.menu && p.menu.length > 0 && <RowMenu items={p.menu} title={typeof p.name === "string" ? p.name : undefined} />}
      </div>
      {p.below && <div className="more">{p.below}</div>}
      {p.expand?.open && p.children && <div className="more">{p.children}</div>}
    </div>
  );
}

/** Three bars and the milliseconds, graded by speedOf (lib/connect.ts). The
    Checker's latency column shows the same (checker/ResultsTable.tsx). */
export function Speed({ ms }: { ms: number }) {
  const s = speedOf(ms);
  return (
    <span className="speed num" title={`${s.word}: the last test through it took ${ms} ms`}>
      <span className="ux-speed" data-bars={s.bars} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {ms} ms
    </span>
  );
}

/** ⋯ and the row's other actions under it. Escape or a click anywhere else
    closes it. On a phone they come up from the bottom in a sheet, the row's
    name above them, within the thumb's reach. */
function RowMenu({ items, title }: { items: RowMenuItem[]; title?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const phone = isMobile();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <span className="relative flex-none">
      <button
        ref={button}
        type="button"
        className={cx("ux-iconbtn", open && "is-on")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        title="More"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon.more className="h-[18px] w-[18px]" />
      </button>
      {phone ? (
        <PhoneSheet open={open} onClose={() => setOpen(false)} title={title}>
          {items.map((it) => (
            <SheetItem
              key={it.label}
              label={it.label}
              danger={it.danger}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            />
          ))}
        </PhoneSheet>
      ) : open && (
        <>
          <button type="button" aria-label="Close the menu" tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div role="menu" className="ux-float ux-rowmenu rise-in absolute right-0 top-full z-50 mt-1">
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={cx("item", it.danger && "is-danger")}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
