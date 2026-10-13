import { describe, expect, it } from "vitest";
import { freeGroupName, lastCheckWords, quickPlaces, samePlace, tabOf, type GroupView, type ProxyView } from "./places";

describe("what a saved proxy's row says about its last check", () => {
  it("says nothing extra when it was working", () => {
    expect(lastCheckWords({ ok: true, tone: "good", says: "Working · 90 ms", at: 1 })).toBeNull();
    expect(lastCheckWords(undefined)).toBeNull();
  });

  it("names why a proxy that answered is still no use", () => {
    expect(lastCheckWords({ ok: false, tone: "bad", says: "Can't open https sites", at: 1 })).toEqual({
      text: "Can't open https sites",
      tone: "danger",
    });
  });

  it("keeps the old words for checks saved before the verdict existed", () => {
    expect(lastCheckWords({ ok: false, at: 1 })).toEqual({ text: "Not answering", tone: "danger" });
    expect(lastCheckWords({ ok: true, at: 1 })).toBeNull();
  });

  it("warns about a proxy that works with a catch", () => {
    expect(lastCheckWords({ ok: true, tone: "warn", says: "Slow · 2300 ms", at: 1 })).toEqual({ text: "Slow · 2300 ms", tone: "warn" });
    expect(lastCheckWords({ ok: true, tone: "bad", says: "Reads your HTTPS", at: 1 })).toEqual({ text: "Reads your HTTPS", tone: "danger" });
  });
});

const proxy = (id: string, addedAt: number, uses: number, lastUsedAt: number): ProxyView => ({ id, address: `${id}:1`, addedAt, uses, lastUsedAt });
const group = (name: string, uses = 0, lastUsedAt = 0): GroupView => ({
  id: name,
  name,
  size: 1,
  rule: "every_connection",
  addedAt: 0,
  uses,
  lastUsedAt,
  summary: { shared: {}, sessions: 0 },
});

describe("quickPlaces", () => {
  it("puts the places used last first, then proxies not used yet, newest added first", () => {
    const proxies = [proxy("a", 10, 2, 100), proxy("b", 50, 0, 0), proxy("c", 20, 1, 300), proxy("d", 60, 0, 0)];
    const groups = [group("L", 1, 200), group("unused")];
    const got = quickPlaces(proxies, groups, 10).map((q) => (q.kind === "proxy" ? q.proxy.id : q.group.id));
    expect(got).toEqual(["c", "L", "a", "d", "b"]);
  });

  it("stops at the number asked for", () => {
    const proxies = [proxy("a", 1, 0, 0), proxy("b", 2, 0, 0), proxy("c", 3, 0, 0)];
    expect(quickPlaces(proxies, [], 2)).toHaveLength(2);
    expect(quickPlaces(proxies, [], 0)).toHaveLength(0);
  });
});

describe("samePlace", () => {
  it("compares places by what they connect to", () => {
    expect(samePlace({ kind: "proxy", id: "a" }, { kind: "proxy", id: "a" })).toBe(true);
    expect(samePlace({ kind: "proxy", id: "a" }, { kind: "group", id: "a" })).toBe(false);
    expect(samePlace({ kind: "free", country: "", socks5: false }, { kind: "free", country: "", socks5: true })).toBe(false);
    expect(samePlace({ kind: "free", country: "DE", socks5: false }, { kind: "free", country: "FR", socks5: false })).toBe(false);
    expect(samePlace(null, { kind: "group", id: "x" })).toBe(false);
  });

  it("takes a free proxy picked from a list as its own place, under any country", () => {
    const picked = { kind: "free", country: "DE", socks5: false, exit: "203.0.113.9:3128" } as const;
    expect(samePlace(picked, { ...picked, exitCountry: "DE" })).toBe(true);
    expect(samePlace(picked, { ...picked, country: "" })).toBe(true);
    expect(samePlace(picked, { kind: "free", country: "DE", socks5: false })).toBe(false);
    expect(samePlace(picked, { ...picked, exit: "203.0.113.10:3128" })).toBe(false);
    expect(samePlace(picked, { ...picked, socks5: true })).toBe(false);
  });
});

describe("names and tabs", () => {
  it("finds a free name for a new group", () => {
    const groups = [group("Pasted 3 Oct"), group("pasted 3 oct 2")];
    expect(freeGroupName(groups, "Pasted 3 Oct")).toBe("Pasted 3 Oct 3");
    expect(freeGroupName(groups, "Working 3 Oct")).toBe("Working 3 Oct");
  });

  it("lists each kind of place on its own tab, and nothing picked on My proxies", () => {
    expect(tabOf({ kind: "proxy", id: "a" })).toBe("proxies");
    expect(tabOf({ kind: "group", id: "g" })).toBe("groups");
    expect(tabOf({ kind: "free", country: "", socks5: false })).toBe("free");
    expect(tabOf(null)).toBe("proxies");
  });
});
