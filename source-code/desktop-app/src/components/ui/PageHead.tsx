/* ============================================================
   PAGE HEAD — the title of a screen, one line under it saying what
   the screen is for, and an optional control on the right (look D,
   2026-09-23). The same size on every screen, so moving between
   tabs never feels like opening another app.

   With `info`, the "i" beside the title carries what the screen is for
   (2026-10-02): the line under it stays for what is happening now.

   USAGE
     <PageHead title="History" info="Counts only, never the addresses."
               aside={<Button>Clear history</Button>} />
   ============================================================ */

import type { ReactNode } from "react";
import { InfoTip } from "./Tip";

export type PageHeadProps = {
  title: string;
  sub?: ReactNode;
  /** What the screen is for, behind an "i" beside the title. */
  info?: ReactNode;
  aside?: ReactNode;
};

export function PageHead({ title, sub, info, aside }: PageHeadProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-[24px] font-extrabold tracking-[-0.02em] text-ink">
          {title}
          {info && <InfoTip label={title}>{info}</InfoTip>}
        </h1>
        {sub && <p className="mt-1.5 max-w-[72ch] text-[14px] font-medium leading-relaxed text-ink-mute">{sub}</p>}
      </div>
      {aside}
    </div>
  );
}
