/* ============================================================
   PAGE HEAD — the title of a screen, one line under it saying what
   the screen is for, and an optional control on the right (look D,
   2026-09-23). The same size on every screen, so moving between
   tabs never feels like opening another app.

   USAGE
     <PageHead title="History" sub="Your last 12 runs on this machine."
               aside={<Button>Clear history</Button>} />
   ============================================================ */

import type { ReactNode } from "react";

export type PageHeadProps = {
  title: string;
  sub?: ReactNode;
  aside?: ReactNode;
};

export function PageHead({ title, sub, aside }: PageHeadProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[24px] font-extrabold tracking-[-0.02em] text-ink">{title}</h1>
        {sub && <p className="mt-1.5 max-w-[72ch] text-[14px] font-medium leading-relaxed text-ink-mute">{sub}</p>}
      </div>
      {aside}
    </div>
  );
}
