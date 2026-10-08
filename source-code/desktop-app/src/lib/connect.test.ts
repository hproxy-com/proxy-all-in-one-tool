import { beforeEach, describe, expect, it } from "vitest";
import {
  addressInUse,
  formatAgo,
  formatBytes,
  formatDuration,
  freeCountryName,
  lineParts,
  listLines,
  loadTarget,
  maskLine,
  placeOf,
  ruleWords,
  sameTarget,
  saveTarget,
  verdictOf,
} from "./connect";
import type { CheckResult } from "./checker";

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

  it("builds a place from whatever is known", () => {
    expect(placeOf({ city: "Paris", country_code: "FR" })).toBe("Paris, France");
    expect(placeOf({ country_code: "FR" })).toBe("France");
    expect(placeOf({ city: "Paris" })).toBe("Paris");
    expect(placeOf({})).toBeUndefined();
  });
});

describe("where to", () => {
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

  it("remembers the last choice of each kind and forgets on null", () => {
    saveTarget({ kind: "fixed", line: "a:1:u:p" });
    expect(loadTarget()).toEqual({ kind: "fixed", line: "a:1:u:p" });
    saveTarget({ kind: "free", country: "DE", socks5: true });
    expect(loadTarget()).toEqual({ kind: "free", country: "DE", socks5: true });
    saveTarget({ kind: "list", id: "l1" });
    expect(loadTarget()).toEqual({ kind: "list", id: "l1" });
    saveTarget(null);
    expect(loadTarget()).toBeNull();
  });

  it("remembers a free proxy picked from the list, and drops a blank one", () => {
    saveTarget({ kind: "free", country: "", socks5: false, exit: "203.0.113.9:3128", exitCountry: "NL" });
    expect(loadTarget()).toStrictEqual({ kind: "free", country: "", socks5: false, exit: "203.0.113.9:3128", exitCountry: "NL" });
    store.set("hproxy-checker-connect-target", JSON.stringify({ kind: "free", country: "DE", socks5: true, exit: "  ", exitCountry: "DE" }));
    expect(loadTarget()).toStrictEqual({ kind: "free", country: "DE", socks5: true });
  });

  it("reads junk as no choice", () => {
    store.set("hproxy-checker-connect-target", "{oops");
    expect(loadTarget()).toBeNull();
    store.set("hproxy-checker-connect-target", JSON.stringify({ kind: "fixed", line: "  " }));
    expect(loadTarget()).toBeNull();
    store.set("hproxy-checker-connect-target", JSON.stringify({ kind: "teleport" }));
    expect(loadTarget()).toBeNull();
  });

  it("compares choices by what they connect to", () => {
    expect(sameTarget({ kind: "fixed", line: " a:1 " }, { kind: "fixed", line: "a:1" })).toBe(true);
    expect(sameTarget({ kind: "free", country: "", socks5: false }, { kind: "free", country: "", socks5: true })).toBe(false);
    // A picked free proxy is its own place: not the country, not another proxy.
    const picked = { kind: "free", country: "DE", socks5: false, exit: "203.0.113.9:3128" } as const;
    expect(sameTarget(picked, { ...picked, exitCountry: "DE" })).toBe(true);
    expect(sameTarget(picked, { kind: "free", country: "DE", socks5: false })).toBe(false);
    expect(sameTarget(picked, { ...picked, exit: "203.0.113.10:3128" })).toBe(false);
    expect(sameTarget(picked, { ...picked, country: "" })).toBe(true);
    expect(sameTarget(picked, { ...picked, socks5: true })).toBe(false);
    expect(sameTarget({ kind: "free", country: "DE", socks5: false }, { kind: "free", country: "FR", socks5: false })).toBe(false);
    expect(sameTarget({ kind: "list", id: "x" }, { kind: "fixed", line: "x" })).toBe(false);
    expect(sameTarget(null, { kind: "list", id: "x" })).toBe(false);
  });

  it("reads the address out of the upstream the relay reports", () => {
    expect(addressInUse("http://203.0.113.5:8080 (no login)")).toBe("203.0.113.5:8080");
    expect(addressInUse("socks5://user:********@[2001:db8::1]:1080")).toBe("[2001:db8::1]:1080");
    expect(addressInUse("switching to a fresh exit")).toBeNull();
    expect(addressInUse("")).toBeNull();
  });

  it("says a list's rule and a free country in words", () => {
    expect(ruleWords("every_n", 25)).toBe("a new proxy every 25 connections");
    expect(ruleWords("on_failure")).toBe("the same proxy until it dies");
    expect(freeCountryName("")).toBe("Anywhere");
    expect(freeCountryName("DE")).toBe("Germany");
    expect(freeCountryName("zz")).toBe("ZZ");
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
