import { beforeEach, describe, expect, it } from "vitest";
import { readWindowStorage } from "./windowStorage";

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

const SAVED = "hproxy-checker-saved-proxies";
const LISTS = "hproxy-checker-saved-lists";
const TARGET = "hproxy-checker-connect-target";

describe("the window's old storage", () => {
  it("is empty when the window never kept anything", () => {
    expect(readWindowStorage()).toEqual({ saved: [], lists: [], target: null });
  });

  it("hands over what it kept, leaving out only what is plainly not an entry", () => {
    store.set(SAVED, JSON.stringify([{ id: "x", line: "a:1:u:p", name: "Work" }, { line: "  " }, "junk", { id: "y" }, { line: "b:2" }]));
    store.set(LISTS, JSON.stringify([{ id: "l1", name: "L", lines: ["a:1", 7], rule: "every_n" }, { name: "no id", lines: [] }, null]));
    store.set(TARGET, JSON.stringify({ kind: "list", id: "l1" }));
    const old = readWindowStorage();
    expect(old.saved).toEqual([{ id: "x", line: "a:1:u:p", name: "Work" }, { line: "b:2" }]);
    // A line that is not text is the library's to leave out; the group still moves.
    expect(old.lists).toEqual([{ id: "l1", name: "L", lines: ["a:1", 7], rule: "every_n" }]);
    expect(old.target).toEqual({ kind: "list", id: "l1" });
  });

  it("reads a damaged key as empty without losing the others", () => {
    store.set(SAVED, "{oops");
    store.set(TARGET, JSON.stringify({ kind: "fixed", line: "a:1" }));
    expect(readWindowStorage()).toEqual({ saved: [], lists: [], target: { kind: "fixed", line: "a:1" } });
  });

  it("takes a pick only in a shape the library reads", () => {
    for (const t of [{ kind: "fixed", line: " " }, { kind: "list" }, { kind: "free", country: 7 }, { kind: "teleport" }, "x"]) {
      store.set(TARGET, JSON.stringify(t));
      expect(readWindowStorage().target).toBeNull();
    }
    store.set(TARGET, JSON.stringify({ kind: "free", socks5: true }));
    expect(readWindowStorage().target).toEqual({ kind: "free", socks5: true });
  });

  it("never removes what it read: an older version of the app still finds it", () => {
    store.set(SAVED, JSON.stringify([{ line: "a:1" }]));
    store.set(TARGET, JSON.stringify({ kind: "fixed", line: "a:1" }));
    readWindowStorage();
    expect([...store.keys()].sort()).toEqual([TARGET, SAVED].sort());
  });
});
