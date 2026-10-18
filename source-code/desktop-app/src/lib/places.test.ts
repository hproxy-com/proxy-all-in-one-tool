import { describe, expect, it } from "vitest";
import {
  changePlaces,
  cleanDate,
  dayWords,
  daysLeft,
  expiryOf,
  firstPlace,
  firstWorking,
  freeGroupName,
  lastCheckWords,
  quickPlaces,
  samePlace,
  tabOf,
  type ChangePlace,
  type GroupView,
  type ProxyView,
} from "./places";

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

/** A proxy whose last check answered in `ms` (or did not answer: null). */
const checked = (id: string, ms: number | null, addedAt = 0): ProxyView => ({
  ...proxy(id, addedAt, 0, 0),
  last: ms == null ? { ok: false, at: 1 } : { ok: true, latencyMs: ms, at: 1 },
});
const ids = (places: ChangePlace[]) => places.map((c) => (c.kind === "proxy" ? c.proxy.id : c.kind === "group" ? c.group.id : "free"));

describe("changePlaces", () => {
  it("puts the one in use first, then the working ones fastest first", () => {
    const proxies = [checked("slow", 400), checked("fast", 50), checked("mid", 120), checked("used", 900)];
    const got = changePlaces(proxies, [], { kind: "proxy", id: "used" }, 10);
    expect(ids(got.places)).toEqual(["used", "fast", "mid", "slow"]);
    expect(got.working).toBe(4);
  });

  it("never offers one that did not answer, unless it is the one in use", () => {
    const proxies = [checked("dead", null), checked("ok", 80)];
    expect(ids(changePlaces(proxies, [], null, 10).places)).toEqual(["ok"]);
    expect(ids(changePlaces(proxies, [], { kind: "proxy", id: "dead" }, 10).places)).toEqual(["dead", "ok"]);
  });

  it("then the unchecked ones and the groups, used last first, new groups last", () => {
    const proxies = [checked("ok", 80), proxy("used", 1, 1, 300), proxy("fresh", 50, 0, 0)];
    const groups = [group("G", 1, 200), group("new")];
    expect(ids(changePlaces(proxies, groups, null, 10).places)).toEqual(["ok", "used", "G", "fresh", "new"]);
  });

  it("shows the free proxy in use, and stops at the number asked for", () => {
    const free = { kind: "free" as const, country: "", socks5: false };
    const proxies = [checked("a", 10), checked("b", 20), checked("c", 30)];
    expect(ids(changePlaces(proxies, [], free, 3).places)).toEqual(["free", "a", "b"]);
    expect(changePlaces(proxies, [], free, 0).places).toEqual([]);
  });
});

describe("firstPlace", () => {
  it("is the fastest working proxy, else the one used or added last, never a free one", () => {
    expect(firstPlace([checked("slow", 300), checked("fast", 40)], [])).toEqual({ kind: "proxy", id: "fast" });
    expect(firstPlace([checked("dead", null)], [])).toEqual({ kind: "proxy", id: "dead" });
    expect(firstPlace([], [group("G", 1, 5)])).toEqual({ kind: "group", id: "G" });
    expect(firstPlace([], [])).toBeNull();
  });
});

describe("firstWorking", () => {
  it("takes the first saved one that answered, else the first", () => {
    const proxies = [checked("a", null), checked("b", 90), checked("c", 20)];
    expect(firstWorking(["a", "b", "c"], proxies)).toBe("b");
    expect(firstWorking(["a"], proxies)).toBe("a");
    expect(firstWorking(["gone"], proxies)).toBeNull();
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

describe("the day a place expires", () => {
  it("is one day of the calendar written year-month-day, as the library keeps it", () => {
    expect(cleanDate("2026-11-14")).toBe("2026-11-14");
    expect(cleanDate("2028-02-29")).toBe("2028-02-29");
    for (const wrong of ["2026-02-29", "2026-04-31", "2026-13-01", "14.11.2026", "1999-12-31", ""]) expect(cleanDate(wrong)).toBeNull();
  });

  it("counts calendar days: 0 on its last day, below 0 once past", () => {
    expect(daysLeft("2026-11-14", "2026-11-14")).toBe(0);
    expect(daysLeft("2027-01-02", "2026-12-30")).toBe(3);
    expect(daysLeft("2028-03-01", "2028-02-28")).toBe(2);
    expect(daysLeft("2026-11-14", "2026-11-16")).toBe(-2);
  });

  it("reads quiet with time left, amber in its last three days, red once past", () => {
    const today = "2026-11-10";
    expect(expiryOf(undefined, today)).toBeNull();
    expect(expiryOf("2026-11-22", today)).toEqual({ days: 12, words: "12 days left", tone: "quiet" });
    expect(expiryOf("2026-11-13", today)).toEqual({ days: 3, words: "3 days left", tone: "warn" });
    expect(expiryOf("2026-11-11", today)).toEqual({ days: 1, words: "1 day left", tone: "warn" });
    expect(expiryOf("2026-11-10", today)).toEqual({ days: 0, words: "Expires today", tone: "warn" });
    expect(expiryOf("2026-11-01", today)).toEqual({ days: -9, words: "Expired", tone: "danger" });
  });

  it("is said with its year only when it is not this year's", () => {
    expect(dayWords("2026-11-14", "2026-10-15")).toBe("14 Nov");
    expect(dayWords("2027-01-02", "2026-10-15")).toBe("2 Jan 2027");
  });
});
