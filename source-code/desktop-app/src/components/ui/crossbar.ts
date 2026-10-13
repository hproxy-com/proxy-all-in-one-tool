import { useLayoutEffect, useRef, type RefObject } from "react";

/* ============================================================
   THE CROSSBAR — under a row of words (a page's parts: Proxies'
   My proxies / Groups / Free, the Checker's Working / Not working /
   All), the current one has the H's crossbar under it, which slides
   to the next (styles/pages.css, .ux-pagetabs). Placed at once the
   first time and when the row changes size (a font arriving, a
   narrower window), sliding after that.

   USAGE   const row = useRef(null), bar = useRef(null);
           useCrossbar(row, bar, value);
           <nav ref={row} className="ux-pagetabs">
             <button aria-current={on ? "page" : undefined}>…</button>…
             <i ref={bar} className="ux-pagetabs-bar" />
           </nav>
   ============================================================ */

export function useCrossbar(row: RefObject<HTMLElement | null>, bar: RefObject<HTMLElement | null>, value: unknown): void {
  const placed = useRef(false);
  useLayoutEffect(() => {
    const r = row.current;
    const b = bar.current;
    if (!r || !b) return;
    const place = (still: boolean) => {
      const on = r.querySelector<HTMLElement>("[aria-current='page']");
      if (!on) return;
      if (still) b.dataset.still = "";
      b.style.transform = `translateX(${on.offsetLeft}px)`;
      b.style.width = `${on.offsetWidth}px`;
      if (still) requestAnimationFrame(() => delete b.dataset.still);
    };
    place(!placed.current);
    placed.current = true;
    const watch = new ResizeObserver(() => place(true));
    watch.observe(r);
    return () => watch.disconnect();
  }, [row, bar, value]);
}
