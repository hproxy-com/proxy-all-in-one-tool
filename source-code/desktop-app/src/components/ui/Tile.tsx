/* ============================================================
   TILE, DOT, FLAG — the facts on a status card.

   A tile is a filled block with a small label in our blue, one big
   figure and a line under it. The dot is the live indicator beside
   a heading; it breathes while live. The flag is the flag as it is,
   with rounded corners and no ring (look D, 2026-09-23: unfx's
   dashed ring was one of the parts that made the app read as its
   reskin).

   THE LAW: values in, visuals owned here and in globals.css, no
   `className` prop.
   ============================================================ */

import type { ReactNode } from "react";
import type { Tone } from "./Badge";
import { cx } from "./tokens";

export type TileProps = {
  label: string;
  value: ReactNode;
  /** A line under the figure, muted. */
  sub?: ReactNode;
  tone?: Tone;
};

export function Tile({ label, value, sub, tone }: TileProps) {
  return (
    <div className={cx("ux-tile", tone && `tone-${tone}`)}>
      <span className="label">{label}</span>
      <span className="value num">{value}</span>
      {sub != null && <span className="sub">{sub}</span>}
    </div>
  );
}

export function Dot({ tone = "ok", live = false }: { tone?: Tone; live?: boolean }) {
  return <span className={cx("ux-dot", `tone-${tone}`, live && "is-live")} aria-hidden="true" />;
}

/** A country flag. With no code, a quiet swatch of the same size. */
export function Flag({ cc, title }: { cc?: string | null; title?: string }) {
  const code = cc?.toLowerCase();
  return (
    <span className="ux-flag" title={title ?? code?.toUpperCase()}>
      {code ? <span className={`fi fi-${code}`} /> : <span className="ux-flag-blank" />}
    </span>
  );
}
