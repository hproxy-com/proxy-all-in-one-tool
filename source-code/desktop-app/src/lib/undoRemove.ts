/* Removes that wait before they happen, so Restore can take them back (since 2026-10-18): a proxy
   that failed one test may only be down a while.

   The proxies leave the list at once and are forgotten UNDO_MS later, unless Restore comes first.
   A second Remove while one waits forgets the first at once and gives the new one its own time.
   If the app closes before the time is up, nothing was forgotten: a wrong click never loses a
   proxy. */

/** How long Restore stays. */
export const UNDO_MS = 5000;

/** The remove that waits: which ones, and since when (for the bar's running line). */
export type PendingRemove = { ids: string[]; at: number };

type Timers = {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** `commit` forgets them for good; `notify` hears every change of what waits (null: nothing). */
export function pendingRemoves(
  commit: (ids: string[]) => void | Promise<unknown>,
  notify: (pending: PendingRemove | null) => void,
  timers: Timers = realTimers,
) {
  let waiting: (PendingRemove & { handle: unknown }) | null = null;

  /** The one waiting, forgotten now; settles when the forgetting is done, so a save made
      right after (the same line pasted again) can never be undone by it. */
  const flush = async (): Promise<void> => {
    if (!waiting) return;
    const { ids, handle } = waiting;
    timers.clear(handle);
    waiting = null;
    notify(null);
    await commit(ids);
  };

  return {
    /** Take them out of the list; they are forgotten when the time is up. */
    remove(ids: string[], now = Date.now()) {
      const unique = [...new Set(ids)];
      if (!unique.length) return;
      void flush();
      const entry: PendingRemove & { handle: unknown } = { ids: unique, at: now, handle: null };
      entry.handle = timers.set(() => {
        if (waiting !== entry) return;
        waiting = null;
        notify(null);
        void commit(entry.ids);
      }, UNDO_MS);
      waiting = entry;
      notify({ ids: unique, at: now });
    },
    /** Put them back: nothing is forgotten. */
    restore() {
      if (!waiting) return;
      timers.clear(waiting.handle);
      waiting = null;
      notify(null);
    },
    flush,
  };
}
