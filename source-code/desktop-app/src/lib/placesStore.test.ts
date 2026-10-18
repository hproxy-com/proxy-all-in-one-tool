import { describe, expect, it } from "vitest";
import { EMPTY_LIBRARY, type LibraryView, type PlacesStart } from "./places";
import { createPlacesStore, type PlacesBridge } from "./placesStore";
import type { WindowStorage } from "./windowStorage";

const view = (ids: string[], more: Partial<LibraryView> = {}): LibraryView => ({
  proxies: ids.map((id) => ({ id, address: `${id}:1`, addedAt: 0, lastUsedAt: 0, uses: 0 })),
  groups: [],
  picked: null,
  ...more,
});
const ids = (v: LibraryView) => v.proxies.map((p) => p.id);
const started = (v: LibraryView, more: Partial<PlacesStart> = {}): Promise<PlacesStart> => Promise.resolve({ view: v, movedFromWindow: true, ...more });

/** A pretend app: every change answers with a view, as the real one does. */
function pretendApp(over: Partial<PlacesBridge> = {}): PlacesBridge {
  return {
    get: () => started(view(["a"])),
    move: () => Promise.resolve(view(["a", "old"])),
    add: (lines) => Promise.resolve({ view: view(["new", "a"]), ids: lines.map(() => "new") }),
    rename: () => Promise.resolve(view(["a"])),
    nameEach: () => Promise.resolve(view(["a"])),
    describe: () => Promise.resolve(view(["a"])),
    describeGroup: () => Promise.resolve(view(["a"])),
    forget: () => Promise.resolve(view([])),
    pick: (place) => Promise.resolve(view(["a"], { picked: place })),
    saveGroup: () => Promise.resolve({ view: view(["a"]), ids: ["g1"] }),
    forgetGroup: () => Promise.resolve(view(["a"])),
    check: (id) => Promise.resolve({ id, address: "x:1", name: "Not this", addedAt: 0, lastUsedAt: 0, uses: 0, last: { ok: true, at: 9 } }),
    ...over,
  };
}
const nothingOld = (): WindowStorage => ({ saved: [], lists: [], target: null });

describe("the places store", () => {
  it("is empty and not ready until the app answers, then shows what it keeps", async () => {
    const s = createPlacesStore(pretendApp({ get: () => started(view(["a"]), { notice: "read from the copy" }) }), nothingOld);
    expect(s.snapshot()).toEqual({ view: EMPTY_LIBRARY, ready: false, notice: null });
    await s.start();
    expect(s.snapshot().ready).toBe(true);
    expect(ids(s.snapshot().view)).toEqual(["a"]);
    expect(s.snapshot().notice).toBe("read from the copy");
  });

  it("moves the window's old storage in once, however often it is started", async () => {
    let moves = 0;
    const old: WindowStorage = { saved: [{ line: "o:1" }], lists: [], target: null };
    const s = createPlacesStore(
      pretendApp({
        get: () => started(view(["a"]), { movedFromWindow: moves > 0 }),
        move: (given) => {
          expect(given).toEqual(old);
          moves += 1;
          return Promise.resolve(view(["a", "old"]));
        },
      }),
      () => old,
    );
    await Promise.all([s.start(), s.start()]);
    await s.start();
    expect(moves).toBe(1);
    expect(ids(s.snapshot().view)).toEqual(["a", "old"]);
  });

  it("tries the move again at the next start when it failed, and the message goes", async () => {
    let tries = 0;
    const s = createPlacesStore(
      pretendApp({
        get: () => started(view(["a"]), { movedFromWindow: false }),
        move: () => {
          tries += 1;
          return tries === 1 ? Promise.reject(new Error("busy")) : Promise.resolve(view(["a", "old"]));
        },
      }),
      nothingOld,
    );
    await s.start();
    expect(s.snapshot().notice).toContain("busy");
    await s.start();
    expect(tries).toBe(2);
    expect(ids(s.snapshot().view)).toEqual(["a", "old"]);
    expect(s.snapshot().notice).toBeNull();
  });

  it("shows the view each change answers with, and hands back what was saved", async () => {
    const s = createPlacesStore(pretendApp(), nothingOld);
    await s.start();
    expect(await s.add(["n:1"])).toEqual(["new"]);
    expect(ids(s.snapshot().view)).toEqual(["new", "a"]);
    await s.pick({ kind: "proxy", id: "a" });
    expect(s.snapshot().view.picked).toEqual({ kind: "proxy", id: "a" });
    expect(await s.saveGroup({ name: "G", lines: ["a:1"], rule: "on_failure" })).toBe("g1");
    await s.forget("a");
    expect(s.snapshot().view.proxies).toEqual([]);
  });

  it("passes on what the app refused, and keeps the view it had", async () => {
    const s = createPlacesStore(pretendApp({ pick: () => Promise.reject(new Error("that proxy is not saved here any more")) }), nothingOld);
    await s.start();
    await expect(s.pick({ kind: "proxy", id: "gone" })).rejects.toThrow("not saved");
    expect(ids(s.snapshot().view)).toEqual(["a"]);
  });

  it("never shows an older view over a newer one", async () => {
    let answer!: (s: PlacesStart) => void;
    const s = createPlacesStore(pretendApp({ get: () => new Promise<PlacesStart>((done) => (answer = done)) }), nothingOld);
    const reading = s.refresh(); // asked first, answers last
    await s.forget("a"); // asked second, answers first
    answer({ view: view(["stale"]), movedFromWindow: true });
    await reading;
    expect(s.snapshot().view.proxies).toEqual([]);
  });

  it("takes only what a check found, so a name given meanwhile stays", async () => {
    const named = view(["a"]);
    named.proxies[0].name = "Mine";
    const s = createPlacesStore(pretendApp({ get: () => started(named) }), nothingOld);
    await s.start();
    await s.check("a");
    expect(s.snapshot().view.proxies[0]).toMatchObject({ name: "Mine", last: { ok: true, at: 9 } });
  });

  it("tells whoever listens, and stops when they leave", async () => {
    const s = createPlacesStore(pretendApp(), nothingOld);
    let heard = 0;
    const off = s.subscribe(() => (heard += 1));
    await s.start();
    expect(heard).toBeGreaterThan(0);
    off();
    const before = heard;
    await s.refresh();
    expect(heard).toBe(before);
  });
});
