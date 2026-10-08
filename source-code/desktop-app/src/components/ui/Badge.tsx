/* ============================================================
   TAG and COUNTER — the small filled chips (look D, 2026-09-23).

   Tag      one fact on a row: a protocol, an anonymity grade, the
            proxy software, "K-A". A neutral chip; with a tone, the
            words and a hairline around them take the tone (never a pale
            fill: nothing see-through), so colour stays
            a judgement and never paints a whole row. `quiet` is the
            paler companion used for the value half of a pair.
   Counter  a count as a filled chip with the H's corners, and the
            live tallies while a run is in flight.

   USAGE
     <Tag>socks5</Tag>
     <Tag tone="warn">Transparent</Tag>
     <Tag quiet>1 204</Tag>
     <Counter>Filtered: 1 735</Counter>
   ============================================================ */

import type { ReactNode } from "react";
import { cx } from "./tokens";

export type Tone = "digi" | "aqua" | "ok" | "warn" | "danger" | "mute";

export type TagProps = {
  children: ReactNode;
  /** Omit inside a result row to inherit the row's colour. */
  tone?: Tone;
  /** Pale fill, toned words: the value half of a label and value pair. */
  quiet?: boolean;
  title?: string;
};

export function Tag({ children, tone, quiet = false, title }: TagProps) {
  return (
    <span title={title} className={cx("ux-tag", quiet && "ux-tag--quiet", tone && `tone-${tone}`)}>
      {children}
    </span>
  );
}

/** A state where a button would be: the same height, corners and words as a
    small button, so the end of a row keeps its size when a button turns into
    "Connected". Not pressable. */
export function Status({ children, tone = "ok", title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span role="status" title={title} className={cx("ux-state", `tone-${tone}`)}>
      {children}
    </span>
  );
}

export function Counter({ children, quiet = false, title }: { children: ReactNode; quiet?: boolean; title?: string }) {
  return (
    <span title={title} className={cx("ux-counter num", quiet && "ux-counter--quiet")}>
      {children}
    </span>
  );
}

/** A label and its value as two pills side by side, as unfx shows the facts
    about a loaded list. */
export function Pair({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Tag tone={tone ?? "digi"}>{label}</Tag>
      <Tag tone={tone ?? "digi"} quiet>
        <span className="num">{value}</span>
      </Tag>
    </span>
  );
}
