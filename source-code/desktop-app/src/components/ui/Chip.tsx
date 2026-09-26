/* ============================================================
   CHIP — a small choice you switch on and off: a country in the
   results' filter line (look D, 2026-09-23).

   The H's corners, small; the raised fill when off, our blue when
   on. It presses like every other control (lib/press.ts). Several
   can be on at once, which is what separates it from a ButtonGroup.

   USAGE
     <Chip on={picked} onClick={toggle} title="Germany">
       <span className="fi fi-de" /> DE <span className="n">12</span>
     </Chip>
   ============================================================ */

import type { ReactNode } from "react";
import { cx } from "./tokens";

export type ChipProps = {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
};

export function Chip({ on, onClick, children, title }: ChipProps) {
  return (
    <button type="button" aria-pressed={on} title={title} onClick={onClick} className={cx("ux-chip", on && "is-on")}>
      {children}
    </button>
  );
}
