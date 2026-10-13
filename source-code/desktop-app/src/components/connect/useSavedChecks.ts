import { useState } from "react";
import { placesStore } from "../../lib/placesStore";
import type { ProxyView } from "../../lib/places";

/** How many saved proxies Test all checks at once. */
const AT_ONCE = 4;

/* Saved proxies checked again: one row's "Check again", or Test all. The
   line never comes here: the app checks a proxy by its id and keeps what it
   finds, and the row reads it from the places. */
export function useSavedChecks(proxies: ProxyView[]) {
  const [testing, setTesting] = useState<{ done: number; total: number } | null>(null);
  // The ones being checked right now, by id, so their rows can say so.
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(() => new Set());
  const markChecking = (id: string, on: boolean) =>
    setCheckingIds((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const checkSaved = async (id: string) => {
    markChecking(id, true);
    try {
      await placesStore.check(id);
    } catch {
      /* one that is gone, or cannot be read, keeps its last word */
    } finally {
      markChecking(id, false);
    }
  };

  /* Every saved proxy, four at a time, each row's verdict updated as its
     answer lands. */
  const testAll = async () => {
    const ids = proxies.map((p) => p.id);
    if (!ids.length) return;
    let done = 0;
    setTesting({ done, total: ids.length });
    const queue = [...ids];
    const work = async () => {
      while (queue.length) {
        await checkSaved(queue.shift()!);
        done += 1;
        setTesting({ done, total: ids.length });
      }
    };
    await Promise.all(Array.from({ length: AT_ONCE }, work));
    setTesting(null);
  };

  return { testing, checkingIds, checkSaved, testAll };
}
