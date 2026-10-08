import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFraudCache,
  fraudLabel,
  fraudScores,
  fraudTone,
  isIpAddress,
  LOOKUP_BATCH,
  missingKey,
  scoredIp,
  serviceRequest,
  testFraudService,
  type FraudRow,
} from "./fraud";
import { DEFAULT_SETTINGS, loadSettings } from "./settings";

/* Fraud scores: FFraud's free lookup by default, or the
   person's own key at another service. What is tested here is what the app is
   asked to send, that no address is asked twice in a session, and that a
   missing key is said before anything is sent. The services' own answers are
   tested in proxy-engine/hproxy-api/src/fraud.rs. */

const score = (ip: string, n: number): FraudRow => ({
  ip,
  score: { ip, score: n, risk: n > 50 ? "high" : "low", flags: [], reason: null, service: "FFraud" },
  error: null,
});

beforeEach(() => clearFraudCache());

describe("what the app is sent", () => {
  it("names the service and passes the key it needs", () => {
    expect(serviceRequest("ffraud", {})).toEqual({ service: "ffraud" });
    expect(serviceRequest("ipqs", { ipqs: " abc " })).toEqual({ service: "ipqs", key: "abc" });
    expect(serviceRequest("scamalytics", { scamalytics: "me:abc" })).toEqual({ service: "scamalytics", address: "me:abc" });
    expect(serviceRequest("abuseipdb", { abuseipdb: "k" })).toEqual({ service: "abuseipdb", key: "k" });
  });

  it("asks proxycheck.io without a key when none is given", () => {
    expect(serviceRequest("proxycheck", {})).toEqual({ service: "proxycheck" });
    expect(serviceRequest("proxycheck", { proxycheck: "k" })).toEqual({ service: "proxycheck", key: "k" });
  });

  it("says a key is missing before anything is sent", () => {
    expect(missingKey("ffraud", {})).toBeNull();
    expect(missingKey("proxycheck", {})).toBeNull();
    // The same sentence the app itself says (hproxy-api fraud.rs).
    expect(missingKey("ipqs", {})).toBe("IPQualityScore needs your API key (Settings, Fraud score)");
    expect(missingKey("scamalytics", { scamalytics: "  " })).toBe("Scamalytics needs your API address (Settings, Fraud score)");
    expect(missingKey("abuseipdb", { abuseipdb: "k" })).toBeNull();
  });
});

describe("how a score reads", () => {
  it("colours by our bands, the same for every service", () => {
    expect([0, 24, 25, 74, 75, 100].map(fraudTone)).toEqual(["ok", "ok", "warn", "warn", "danger", "danger"]);
  });

  it("shows the service's own word beside the number when it gives one", () => {
    expect(fraudLabel(score("1.2.3.4", 12).score!)).toBe("12 · low");
    expect(fraudLabel({ ...score("1.2.3.4", 88).score!, risk: null })).toBe("88");
  });
});

describe("which address a proxy is scored by", () => {
  it("takes the exit, then the proxy's own address when it is one", () => {
    expect(scoredIp({ exitIp: "198.51.100.7", host: "gw.example.com" })).toBe("198.51.100.7");
    expect(scoredIp({ host: "203.0.113.9" })).toBe("203.0.113.9");
    expect(scoredIp({ host: "[2001:db8::1]" })).toBe("2001:db8::1");
    expect(scoredIp({ host: "gw.example.com" })).toBeUndefined();
  });

  it("knows an IP address from a name", () => {
    expect(isIpAddress("192.0.2.10")).toBe(true);
    expect(isIpAddress("192.0.2.300")).toBe(false);
    expect(isIpAddress("2001:db8::1")).toBe(true);
    expect(isIpAddress("proxy.example.com")).toBe(false);
  });
});

describe("looking up", () => {
  it("asks in batches and never asks an address twice in a session", async () => {
    const lookup = vi.fn(async (ips: string[]) => ips.map((ip) => score(ip, 10)));
    const ips = Array.from({ length: LOOKUP_BATCH + 5 }, (_, i) => `198.51.100.${i + 1}`);
    const batches: number[] = [];
    const first = await fraudScores([...ips, ips[0]], "ffraud", {}, (rows) => batches.push(rows.length), lookup);
    expect(first.size).toBe(ips.length);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(batches).toEqual([LOOKUP_BATCH, 5]);

    const again = await fraudScores(ips.slice(0, 3), "ffraud", {}, undefined, lookup);
    expect(again.get(ips[0])?.score?.score).toBe(10);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("keeps each service's scores apart", async () => {
    const lookup = vi.fn(async (ips: string[]) => ips.map((ip) => score(ip, 60)));
    await fraudScores(["192.0.2.1"], "ffraud", {}, undefined, lookup);
    await fraudScores(["192.0.2.1"], "proxycheck", {}, undefined, lookup);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failure, so fixing the key and asking again works", async () => {
    const failing = vi.fn(async (ips: string[]) => ips.map((ip) => ({ ip, score: null, error: "IPQualityScore did not accept the key" })));
    const got = await fraudScores(["192.0.2.2"], "ipqs", { ipqs: "wrong" }, undefined, failing);
    expect(got.get("192.0.2.2")?.error).toContain("did not accept");
    const working = vi.fn(async (ips: string[]) => ips.map((ip) => score(ip, 5)));
    const fixed = await fraudScores(["192.0.2.2"], "ipqs", { ipqs: "right" }, undefined, working);
    expect(fixed.get("192.0.2.2")?.score?.score).toBe(5);
  });

  it("sends nothing while a needed key is missing", async () => {
    const lookup = vi.fn();
    const got = await fraudScores(["192.0.2.3"], "abuseipdb", {}, undefined, lookup);
    expect(lookup).not.toHaveBeenCalled();
    expect(got.get("192.0.2.3")?.error).toBe("AbuseIPDB needs your API key (Settings, Fraud score)");
  });

  it("turns a failed call into one sentence per address", async () => {
    const broken = vi.fn(async () => {
      throw new Error("the app did not answer");
    });
    const got = await fraudScores(["192.0.2.4", "192.0.2.5"], "ffraud", {}, undefined, broken);
    expect([...got.values()].map((r) => r.error)).toEqual(["the app did not answer", "the app did not answer"]);
  });
});

describe("the Settings test", () => {
  it("asks past the session's scores and says what came back", async () => {
    const lookup = vi.fn(async (ips: string[]) => ips.map((ip) => score(ip, 3)));
    await fraudScores(["1.1.1.1"], "ffraud", {}, undefined, lookup);
    const r = await testFraudService("ffraud", {}, lookup);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ ok: true, text: "It works: 1.1.1.1 scores 3 · low at FFraud." });
  });

  it("says a missing key instead of asking", async () => {
    const lookup = vi.fn();
    expect(await testFraudService("ipqs", {}, lookup)).toEqual({ ok: false, text: "IPQualityScore needs your API key (Settings, Fraud score)" });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("the fraud settings", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });

  it("start on FFraud, with no keys, looking up while connected", () => {
    const s = loadSettings();
    expect([s.fraudService, s.fraudKeys, s.fraudOnConnect]).toEqual(["ffraud", {}, true]);
    expect(DEFAULT_SETTINGS.fraudService).toBe("ffraud");
  });

  it("keep what was picked and drop what is not a key", () => {
    store.set(
      "hproxy-checker-settings",
      JSON.stringify({ look: "d-2026-09-23", fraudService: "ipqs", fraudKeys: { ipqs: "abc", abuseipdb: 12, nope: "x" }, fraudOnConnect: false }),
    );
    const s = loadSettings();
    expect([s.fraudService, s.fraudKeys, s.fraudOnConnect]).toEqual(["ipqs", { ipqs: "abc" }, false]);
    store.set("hproxy-checker-settings", JSON.stringify({ fraudService: "whois" }));
    expect(loadSettings().fraudService).toBe("ffraud");
  });
});
