/* The window's copy of the places: the view the app hands over (the shapes in
   lib/places.ts; src-tauri/src/places.rs keeps the places themselves), kept
   fresh, and changed only by asking the app. Every change answers with the
   view after it, so the window never works out a change on its own.

   No React in here: a screen reads the store with useSyncExternalStore
   (components/connect/connection.tsx, usePlaces). Tests make their own store
   over a pretend app (placesStore.test.ts). */

import { EMPTY_LIBRARY, type GroupInput, type LibraryView, type Place, type ProxyView } from "./places";
import {
  placesAdd,
  placesCheck,
  placesForget,
  placesGet,
  placesGroupForget,
  placesGroupSave,
  placesMoveFromWindow,
  placesPick,
  placesRename,
} from "./tauri";
import { readWindowStorage, type WindowStorage } from "./windowStorage";

export type PlacesSnapshot = {
  view: LibraryView;
  /** The app has answered at least once: an empty view is really empty. */
  ready: boolean;
  /** What the app had to say about the library (read from the copy before
      the last save, set aside, not saved), in its words. */
  notice: string | null;
};

/** What the store asks of the app: lib/tauri.ts in the app, a pretend one in tests. */
export type PlacesBridge = {
  get: typeof placesGet;
  move: typeof placesMoveFromWindow;
  add: typeof placesAdd;
  rename: typeof placesRename;
  forget: typeof placesForget;
  pick: typeof placesPick;
  saveGroup: typeof placesGroupSave;
  forgetGroup: typeof placesGroupForget;
  check: typeof placesCheck;
};

export type PlacesStore = ReturnType<typeof createPlacesStore>;

const words = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createPlacesStore(app: PlacesBridge, readOld: () => WindowStorage) {
  let snap: PlacesSnapshot = { view: EMPTY_LIBRARY, ready: false, notice: null };
  const listeners = new Set<() => void>();
  let starting: Promise<void> | null = null;
  /* Every view carries the number of the question it answers. Questions are
     answered in the order they were asked, but should one come back late,
     a view older than the one on screen is never shown over it. */
  let asked = 0;
  let shown = 0;

  const set = (next: Partial<PlacesSnapshot>) => {
    snap = { ...snap, ...next };
    for (const fn of listeners) fn();
  };

  /** Ask the app, and show the view its answer carries. */
  async function ask<T>(question: Promise<T>, viewOf: (answer: T) => LibraryView): Promise<T> {
    const n = ++asked;
    const answer = await question;
    if (n > shown) {
      shown = n;
      set({ view: viewOf(answer), ready: true });
    }
    return answer;
  }
  const same = (v: LibraryView) => v;

  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    snapshot(): PlacesSnapshot {
      return snap;
    },

    /** Read the places, once. The first start with the library moves the
        window's old storage in; should that fail, the next start tries again
        (the app marks it moved only when it was). */
    start(): Promise<void> {
      starting ??= (async () => {
        try {
          const first = await ask(app.get(), (s) => s.view);
          set({ notice: first.notice ?? null });
          if (!first.movedFromWindow) await ask(app.move(readOld()), same);
        } catch (e) {
          starting = null;
          set({ ready: true, notice: `Your places could not be read: ${words(e)}` });
        }
      })();
      return starting;
    },

    /** Read the places again: after the tray connected, or a probe changed a row. */
    async refresh(): Promise<void> {
      await ask(app.get(), (s) => s.view);
    },

    /** Save lines as proxies; the ids of the ones saved now, in the order given. */
    async add(lines: string[]): Promise<string[]> {
      return (await ask(app.add(lines), (a) => a.view)).ids;
    },
    async rename(id: string, name: string): Promise<void> {
      await ask(app.rename(id, name), same);
    },
    async forget(id: string): Promise<void> {
      await ask(app.forget(id), same);
    },
    /** The place the switch connects to. Rejects for one that is gone. */
    async pick(place: Place | null): Promise<void> {
      await ask(app.pick(place), same);
    },
    /** Save a group; its id. Rejects when none of its lines can be read. */
    async saveGroup(group: GroupInput): Promise<string> {
      return (await ask(app.saveGroup(group), (a) => a.view)).ids[0];
    },
    async forgetGroup(id: string): Promise<void> {
      await ask(app.forgetGroup(id), same);
    },

    /** Check a saved proxy again. Only what the check found is taken from the
        answer: a rename made while it ran stays. */
    async check(id: string): Promise<ProxyView> {
      const checked = await app.check(id);
      const proxies = snap.view.proxies.map((p) => (p.id === id ? { ...p, last: checked.last } : p));
      set({ view: { ...snap.view, proxies } });
      return checked;
    },
  };
}

/** The app's places, for the window. */
export const placesStore = createPlacesStore(
  {
    get: placesGet,
    move: placesMoveFromWindow,
    add: placesAdd,
    rename: placesRename,
    forget: placesForget,
    pick: placesPick,
    saveGroup: placesGroupSave,
    forgetGroup: placesGroupForget,
    check: placesCheck,
  },
  readWindowStorage,
);
