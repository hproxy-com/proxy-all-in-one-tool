import { beforeEach, describe, expect, it } from "vitest";
import {
  addManySaved,
  addSaved,
  forget,
  forgetList,
  freeListName,
  listUsed,
  loadLists,
  loadSaved,
  makeList,
  MAX_LIST_LINES,
  MAX_SAVED,
  remember,
  saveLists,
  saveSaved,
  upsertList,
  withVerdict,
  type SavedProxy,
} from "./saved";

/* Vitest runs in node, which has no localStorage. A tiny in-memory stand-in. */
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

describe("remember", () => {
  it("puts a new line first and counts a repeat instead of duplicating it", () => {
    let list: SavedProxy[] = [];
    list = remember(list, "a:1:u:p", 1000);
    list = remember(list, "b:2:u:p", 2000);
    expect(list.map((p) => p.line)).toEqual(["b:2:u:p", "a:1:u:p"]);
    list = remember(list, " a:1:u:p ", 3000);
    expect(list.map((p) => p.line)).toEqual(["a:1:u:p", "b:2:u:p"]);
    expect(list[0].uses).toBe(2);
    expect(list[0].lastUsedAt).toBe(3000);
    expect(list[0].addedAt).toBe(1000);
  });

  it("ignores an empty line", () => {
    expect(remember([], "   ")).toEqual([]);
  });

  it("keeps the most recently used when the list is full", () => {
    let list: SavedProxy[] = [];
    for (let i = 0; i < MAX_SAVED + 3; i++) list = remember(list, `h${i}:1`, i);
    expect(list).toHaveLength(MAX_SAVED);
    expect(list[0].line).toBe(`h${MAX_SAVED + 2}:1`);
    expect(list.some((p) => p.line === "h0:1")).toBe(false);
  });
});

describe("forget and verdicts", () => {
  it("removes exactly the one asked for", () => {
    const list = remember(remember([], "a:1"), "b:2");
    const gone = forget(list, list[1].id);
    expect(gone.map((p) => p.line)).toEqual(["b:2"]);
  });

  it("attaches a verdict to the matching line only", () => {
    const list = remember(remember([], "a:1"), "b:2");
    const v = { ok: true, latencyMs: 120, cc: "de", place: "Berlin, Germany", at: 5 };
    const out = withVerdict(list, "a:1", v);
    expect(out.find((p) => p.line === "a:1")?.last).toEqual(v);
    expect(out.find((p) => p.line === "b:2")?.last).toBeUndefined();
  });
});

describe("storage", () => {
  it("round-trips through localStorage and survives junk", () => {
    const list = remember([], "a:1:u:p", 7);
    saveSaved(list);
    expect(loadSaved()).toEqual(list);
    store.set("hproxy-checker-saved-proxies", "{not json");
    expect(loadSaved()).toEqual([]);
    store.set("hproxy-checker-saved-proxies", JSON.stringify([{ nope: 1 }, { line: "ok:1", id: "x", addedAt: 1, lastUsedAt: 1, uses: 1 }]));
    expect(loadSaved().map((p) => p.line)).toEqual(["ok:1"]);
  });
});

describe("addSaved", () => {
  it("adds without counting a use, and leaves a saved line where it is", () => {
    let list = remember([], "a:1", 10);
    list = addSaved(list, "b:2", 20);
    expect(list.map((p) => p.line)).toEqual(["b:2", "a:1"]);
    expect(list[0].uses).toBe(0);
    const again = addSaved(list, " a:1 ", 30);
    expect(again).toBe(list);
  });
});

describe("saved lists", () => {
  it("cleans the lines: trimmed, no blanks, no repeats, capped", () => {
    const l = makeList("  Mine ", [" a:1 ", "", "b:2", "a:1"], "every_connection", undefined, 5);
    expect(l.name).toBe("Mine");
    expect(l.lines).toEqual(["a:1", "b:2"]);
    expect(l.n).toBeUndefined();
    const big = makeList("", Array.from({ length: MAX_LIST_LINES + 5 }, (_, i) => `h${i}:1`), "every_n", 0, 5);
    expect(big.lines).toHaveLength(MAX_LIST_LINES);
    expect(big.name).toBe("My list");
    expect(big.n).toBe(1);
  });

  it("replaces by id, adds new ones first, forgets exactly one", () => {
    const a = makeList("A", ["a:1"], "random", undefined, 1);
    const b = makeList("B", ["b:1"], "on_failure", undefined, 2);
    let lists = upsertList(upsertList([], a), b);
    expect(lists.map((l) => l.name)).toEqual(["B", "A"]);
    lists = upsertList(lists, { ...a, name: "A2" });
    expect(lists.map((l) => l.name)).toEqual(["B", "A2"]);
    expect(forgetList(lists, b.id).map((l) => l.name)).toEqual(["A2"]);
  });

  it("counts a connection and brings the list to the front", () => {
    const a = makeList("A", ["a:1"], "random", undefined, 1);
    const b = makeList("B", ["b:1"], "random", undefined, 2);
    const lists = listUsed(upsertList(upsertList([], a), b), a.id, 99);
    expect(lists[0].name).toBe("A");
    expect(lists[0].uses).toBe(1);
    expect(lists[0].lastUsedAt).toBe(99);
  });

  it("finds a free name", () => {
    const lists = [makeList("Working", [], "random", undefined, 1), makeList("working 2", [], "random", undefined, 2)];
    expect(freeListName(lists, "Working")).toBe("Working 3");
    expect(freeListName(lists, "Fresh")).toBe("Fresh");
  });

  it("round-trips through storage, drops junk, and says when storage refused", () => {
    const lists = [makeList("A", ["a:1:u:p"], "every_n", 5, 1)];
    expect(saveLists(lists)).toBe(true);
    expect(loadLists()).toEqual(lists);
    store.set("hproxy-checker-saved-lists", JSON.stringify([{ id: "x", name: "bad rule", lines: [], rule: "sometimes" }, lists[0]]));
    expect(loadLists().map((l) => l.name)).toEqual(["A"]);
    const full = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(saveLists(lists)).toBe(false);
    globalThis.localStorage.setItem = full;
  });
});

describe("addManySaved", () => {
  it("keeps the pasted order, skips repeats and lines already saved", () => {
    const list = addManySaved(remember([], "b:2", 1), ["a:1", "b:2", "c:3", "a:1"], 5);
    expect(list.map((p) => p.line)).toEqual(["a:1", "c:3", "b:2"]);
    expect(list.find((p) => p.line === "b:2")?.uses).toBe(1);
  });
});
