import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROTATION,
  ROTATION_HINT,
  ROTATION_RULES,
  aboutWords,
  addressInUse,
  placeName,
  proxyTitle,
  formatAgo,
  formatBytes,
  formatRate,
  groupWords,
  rateBetween,
  formatDuration,
  freeCountryName,
  lineParts,
  listLines,
  maskLine,
  matchSaved,
  placeOf,
  ruleWords,
  sortSaved,
  spacedN,
  speedOf,
  takesN,
  verdictOf,
} from "./connect";
import type { CheckResult } from "./checker";
import type { GroupView, ProxyView } from "./places";

describe("the lists' order, search and speed", () => {
  const proxy = (id: string, address: string, more: Partial<ProxyView> = {}): ProxyView => ({
    id,
    address,
    addedAt: 1,
    lastUsedAt: 1,
    uses: 1,
    ...more,
  });
  const list = [
    proxy("a", "203.0.113.1:8080", { user: "user", name: "Proxy 10", last: { ok: true, latencyMs: 300, place: "Frankfurt, Germany", at: 1 } }),
    proxy("b", "203.0.113.2:3128", { last: { ok: true, latencyMs: 120, place: "Tokyo, Japan", at: 1 } }),
    proxy("c", "203.0.113.3:1080", { name: "Proxy 2" }),
    proxy("d", "203.0.113.4:80", { name: "Dead one", last: { ok: false, at: 1 } }),
    proxy("e", "203.0.113.5:8000", { name: "Work", last: { ok: true, at: 1 } }),
  ];
  const ids = (l: ProxyView[]) => l.map((p) => p.id).join("");

  it("keeps the kept order for Recently used, and never reorders the list it was given", () => {
    expect(ids(sortSaved(list, "recent"))).toBe("abcde");
    sortSaved(list, "fastest");
    expect(ids(list)).toBe("abcde");
  });

  it("puts the quickest working ones first, then working, never checked, not answering", () => {
    expect(ids(sortSaved(list, "fastest"))).toBe("baecd");
  });

  it("goes by name with numbers in number order, an address standing in for a missing name", () => {
    // 203.0.113.2:3128 (no name) sorts as its address, digits before letters.
    expect(sortSaved(list, "name").map((p) => p.name ?? p.address)).toEqual(["203.0.113.2:3128", "Dead one", "Proxy 2", "Proxy 10", "Work"]);
  });

  it("finds by name, address or place; a password is never there to find", () => {
    expect(ids(matchSaved(list, "proxy"))).toBe("ac");
    expect(ids(matchSaved(list, "113.4"))).toBe("d");
    expect(ids(matchSaved(list, "japan"))).toBe("b");
    expect(ids(matchSaved(list, "secret"))).toBe("");
    expect(ids(matchSaved(list, "  "))).toBe("abcde");
  });

  it("grades a proxy by how long the test through it took", () => {
    expect(speedOf(240)).toEqual({ bars: 3, word: "Fast" });
    expect(speedOf(799)).toEqual({ bars: 3, word: "Fast" });
    expect(speedOf(800)).toEqual({ bars: 2, word: "Fine" });
    expect(speedOf(1999)).toEqual({ bars: 2, word: "Fine" });
    expect(speedOf(2000)).toEqual({ bars: 1, word: "Slow" });
    expect(speedOf(undefined)).toEqual({ bars: 1, word: "Slow" });
  });
});

describe("maskLine", () => {
  /* Saved proxies and status lines are the things people screenshot into a
     support chat. The password must not be in them, in any of the shapes a
     provider prints. */
  it("hides the password in every shape and keeps the user", () => {
    expect(maskLine("user:hunter2@1.2.3.4:8080")).toBe("user:••••@1.2.3.4:8080");
    expect(maskLine("socks5://user:hunter2@1.2.3.4:1080")).toBe("socks5://user:••••@1.2.3.4:1080");
    expect(maskLine("1.2.3.4:8080:user:hunter2")).toBe("1.2.3.4:8080:user:••••");
  });

  it("keeps a password that itself contains the separators hidden whole", () => {
    expect(maskLine("1.2.3.4:8080:user:hun:ter@2")).toBe("1.2.3.4:8080:user:••••");
    expect(maskLine("user:hun@ter@1.2.3.4:8080")).toBe("user:••••@1.2.3.4:8080");
  });

  it("leaves a line with no login alone", () => {
    expect(maskLine("1.2.3.4:8080")).toBe("1.2.3.4:8080");
    expect(maskLine("http://1.2.3.4:8080")).toBe("http://1.2.3.4:8080");
  });
});

describe("listLines", () => {
  it("drops blank lines and trims the rest", () => {
    expect(listLines("  a:1 \n\n\r\nb:2\n   \n")).toEqual(["a:1", "b:2"]);
  });
});

describe("formatting", () => {
  it("formats bytes with one decimal under ten", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12.4 * 1024 * 1024)).toBe("12 MB");
    expect(formatBytes(3.2 * 1024 ** 3)).toBe("3.2 GB");
  });

  it("formats an uptime like a clock", () => {
    expect(formatDuration(7_000)).toBe("0:07");
    expect(formatDuration(754_000)).toBe("12:34");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
    expect(formatDuration(-5)).toBe("0:00");
  });

  it("says how long ago in the coarsest unit that fits", () => {
    expect(formatAgo(1_000)).toBe("just now");
    expect(formatAgo(12_000)).toBe("12 s ago");
    expect(formatAgo(200_000)).toBe("3 min ago");
    expect(formatAgo(7_200_000)).toBe("2 h ago");
  });
});

describe("verdictOf", () => {
  const alive: CheckResult = {
    input: "1.2.3.4:8080",
    alive: true,
    ip: "1.2.3.4",
    protocols: ["http", "https"],
    latency_ms: 143,
    anonymity: "elite",
    country_code: "DE",
    country: "Germany",
    city: "Frankfurt",
    asn_org: "Hetzner Online",
    exit_ip: "1.2.3.4",
  };

  it("sums up a working proxy in the order a person reads it", () => {
    const v = verdictOf(alive);
    expect(v.tone).toBe("ok");
    expect(v.headline).toBe("Working · 143 ms");
    expect(v.details).toEqual(["HTTP · HTTPS", "Elite", "Frankfurt, Germany", "Hetzner Online"]);
    expect(v.cc).toBe("de");
  });

  it("names a different exit address, because that is the surprise worth knowing", () => {
    expect(verdictOf({ ...alive, exit_ip: "9.9.9.9" }).details).toContain("exit 9.9.9.9");
  });

  it("warns on a slow proxy rather than calling it fine", () => {
    expect(verdictOf({ ...alive, latency_ms: 2400 }).tone).toBe("warn");
  });

  it("gives the engine's sentence for a dead one", () => {
    const v = verdictOf({ input: "x", alive: false, error: "the proxy did not answer within 8 s" });
    expect(v.tone).toBe("danger");
    expect(v.headline).toBe("Not answering");
    expect(v.details).toEqual(["the proxy did not answer within 8 s"]);
  });

  it("takes the engine's verdict when the row carries one", () => {
    const plainOnly: CheckResult = {
      ...alive,
      protocols: ["http"],
      usable: {
        carries: false,
        tone: "bad",
        says: "Can't open https sites",
        why: "It only fetches plain http:// pages.",
      },
    };
    const v = verdictOf(plainOnly);
    expect(v.tone).toBe("danger");
    expect(v.headline).toBe("Can't open https sites");
    expect(v.details[0]).toBe("It only fetches plain http:// pages.");
  });

  it("keeps the engine's words for a working one, with no sentence in front", () => {
    const v = verdictOf({ ...alive, usable: { carries: true, tone: "good", way: "http", says: "Working · 143 ms" } });
    expect(v.tone).toBe("ok");
    expect(v.headline).toBe("Working · 143 ms");
    expect(v.details[0]).toBe("HTTP · HTTPS");
  });

  it("builds a place from whatever is known", () => {
    expect(placeOf({ city: "Paris", country_code: "FR" })).toBe("Paris, France");
    expect(placeOf({ country_code: "FR" })).toBe("France");
    expect(placeOf({ city: "Paris" })).toBe("Paris");
    expect(placeOf({})).toBeUndefined();
  });
});

describe("words for places", () => {
  it("reads the address out of the upstream the relay reports", () => {
    expect(addressInUse("http://203.0.113.5:8080 (no login)")).toBe("203.0.113.5:8080");
    expect(addressInUse("socks5://user:********@[2001:db8::1]:1080")).toBe("[2001:db8::1]:1080");
    expect(addressInUse("switching to a fresh exit")).toBeNull();
    expect(addressInUse("")).toBeNull();
  });

  it("says a group's rule and a free country in words", () => {
    expect(ruleWords("every_n", 25)).toBe("a new proxy every 25 connections");
    expect(ruleWords("on_failure")).toBe("the same proxy until it dies");
    expect(ruleWords("every_minutes", 10)).toBe("a new proxy every 10 minutes");
    expect(ruleWords("every_minutes", 1)).toBe("a new proxy every minute");
    expect(ruleWords("every_minutes")).toBe("a new proxy every 10 minutes");
    expect(freeCountryName("")).toBe("Anywhere");
    expect(freeCountryName("DE")).toBe("Germany");
    // The pool's countries beyond the app's own table get the browser's name.
    expect(freeCountryName("KH")).toBe("Cambodia");
    expect(freeCountryName("hk")).toBe("Hong Kong");
    expect(freeCountryName("zz")).toBe("ZZ");
  });
});

describe("a hundred sessions on one gateway", () => {
  const session = (id: string, about: ProxyView["about"]): ProxyView => ({
    id,
    address: "gate.example.com:10000",
    user: `acct-country-us-state-california-session-${id}-lifetime-30`,
    addedAt: 1,
    lastUsedAt: 1,
    uses: 0,
    about,
  });

  it("titles a line by its session, not by the address all of them share", () => {
    const a = session("7f3a9c21", { country: "US", region: "california", session: "7f3a9c21", minutes: 30 });
    const b = session("0be2d4aa", { country: "US", region: "california", session: "0be2d4aa", minutes: 30 });
    expect(proxyTitle(a)).toBe("Session 7f3a9c21");
    expect(proxyTitle(b)).not.toBe(proxyTitle(a));
    // A name still comes first, and a login that targets nothing shows the address.
    expect(proxyTitle({ ...a, name: "Shop account" })).toBe("Shop account");
    expect(proxyTitle({ ...a, about: undefined })).toBe("gate.example.com:10000");
  });

  it("says what a line targets in a few words", () => {
    expect(aboutWords({ country: "US", region: "california", session: "7f3a", minutes: 30 })).toBe("California · 30 min");
    expect(aboutWords({ country: "US", city: "los angeles", region: "california", session: "7f3a" })).toBe("Los Angeles · sticky");
    expect(aboutWords({ country: "DE" })).toBe("Rotating · Germany");
    expect(aboutWords(null)).toBe("");
    expect(placeName("new-york")).toBe("New York");
    expect(placeName("NEW_YORK")).toBe("New York");
  });

  it("finds a session by its id or its place", () => {
    const list = [
      session("7f3a9c21", { country: "US", region: "california", session: "7f3a9c21" }),
      session("0be2d4aa", { country: "DE", city: "berlin", session: "0be2d4aa" }),
    ];
    expect(matchSaved(list, "7f3a").map((p) => p.id)).toEqual(["7f3a9c21"]);
    expect(matchSaved(list, "berlin").map((p) => p.id)).toEqual(["0be2d4aa"]);
    expect(matchSaved(list, "germany").map((p) => p.id)).toEqual(["0be2d4aa"]);
    expect(matchSaved(list, "lifetime"), "the login name is not searched, only what it was read as").toEqual([]);
  });
});

describe("how a group moves through its proxies", () => {
  it("starts new groups on one proxy until it dies, and offers that first", () => {
    // A site sees one address for the whole visit: what residential sessions are for.
    expect(DEFAULT_ROTATION).toBe("on_failure");
    expect(ROTATION_RULES[0][0]).toBe(DEFAULT_ROTATION);
  });

  it("explains every rule it offers, and asks a number only where one is needed", () => {
    for (const [rule] of ROTATION_RULES) expect(ROTATION_HINT[rule]).toBeTruthy();
    expect(ROTATION_RULES.map(([rule]) => rule).filter(takesN)).toEqual(["every_minutes", "every_n"]);
  });

  it("says what a group is from its summary: how many, sessions, where they all are", () => {
    const group = (more: Partial<GroupView>): GroupView => ({
      id: "g1",
      name: "G",
      size: 100,
      rule: "on_failure",
      addedAt: 1,
      lastUsedAt: 0,
      uses: 0,
      summary: { shared: {}, sessions: 0 },
      ...more,
    });
    expect(groupWords(group({ summary: { shared: { country: "US", region: "california", minutes: 30 }, sessions: 100 } }))).toBe(
      "100 sessions in California · the same proxy until it dies",
    );
    expect(groupWords(group({ size: 2500, rule: "every_minutes", n: 5 }))).toBe("2 500 proxies · a new proxy every 5 minutes");
    expect(groupWords(group({ size: 1, summary: { shared: { country: "DE" }, sessions: 1 } }))).toBe("1 proxy in Germany · the same proxy until it dies");
    expect(groupWords(group({ summary: { shared: {}, sessions: 40 } }))).toBe("100 proxies · the same proxy until it dies");
    expect(spacedN(1_234_567)).toBe("1 234 567");
  });
});

describe("lineParts", () => {
  it("gives the address and the login name, never the password", () => {
    expect(lineParts("1.2.3.4:8080:alice:hunter2")).toEqual({ address: "1.2.3.4:8080", user: "alice", scheme: undefined });
    expect(lineParts("alice:hunter2@1.2.3.4:8080")).toEqual({ address: "1.2.3.4:8080", user: "alice", scheme: undefined });
    expect(lineParts("socks5://alice:hun@ter2@1.2.3.4:1080")).toEqual({ address: "1.2.3.4:1080", user: "alice", scheme: "socks5" });
    expect(lineParts(" 1.2.3.4:8080 ")).toEqual({ address: "1.2.3.4:8080", scheme: undefined });
    expect(JSON.stringify(lineParts("1.2.3.4:8080:alice:hunter2"))).not.toContain("hunter2");
  });
});

describe("formatRate", () => {
  it("reads like the byte counts, per second", () => {
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(820)).toBe("820 B/s");
    expect(formatRate(12 * 1024)).toBe("12 KB/s");
    expect(formatRate(1.2 * 1024 * 1024)).toBe("1.2 MB/s");
  });
});

describe("rateBetween", () => {
  it("is bytes a second between two readings", () => {
    expect(rateBetween({ at: 0, up: 0, down: 0 }, { at: 2000, up: 2000, down: 10_000 })).toEqual({ up: 1000, down: 5000 });
  });
  it("has nothing without an earlier reading or time between them", () => {
    expect(rateBetween(null, { at: 1000, up: 5, down: 5 })).toBeNull();
    expect(rateBetween({ at: 1000, up: 0, down: 0 }, { at: 1000, up: 5, down: 5 })).toBeNull();
  });
  it("has nothing when the counters start again from zero", () => {
    expect(rateBetween({ at: 0, up: 900, down: 900 }, { at: 1000, up: 10, down: 10 })).toBeNull();
  });
});
