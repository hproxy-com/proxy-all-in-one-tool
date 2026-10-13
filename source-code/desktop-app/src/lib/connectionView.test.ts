import { describe, expect, it } from "vitest";
import { phaseOf, placeView, type PlaceViewInput } from "./connectionView";
import type { GroupView, ProxyView } from "./places";
import type { ConnectStatus, SourceInfo } from "./tauri";

const proxy = (more: Partial<ProxyView> = {}): ProxyView => ({ id: "p1", address: "1.2.3.4:8080", addedAt: 1, lastUsedAt: 1, uses: 1, ...more });
const group = (more: Partial<GroupView> = {}): GroupView => ({
  id: "g1",
  name: "Work",
  size: 12,
  rule: "on_failure",
  addedAt: 1,
  lastUsedAt: 1,
  uses: 1,
  summary: { shared: {}, sessions: 0 },
  ...more,
});
const running = (source: SourceInfo, place: ConnectStatus["place"] = null): ConnectStatus => ({
  running: true,
  system_proxy: true,
  support: { kind: "automatic", how: "" },
  source,
  place,
});
const input = (more: Partial<PlaceViewInput> = {}): PlaceViewInput => ({ proxies: [], groups: [], status: null, connected: null, ...more });

describe("the switch's phase", () => {
  it("says what is under way, else on or off", () => {
    expect(phaseOf("connecting", false)).toBe("connecting");
    expect(phaseOf("switching", true)).toBe("switching");
    expect(phaseOf("stopping", true)).toBe("leaving");
    expect(phaseOf("rotating", true)).toBe("rotating");
    expect(phaseOf("", true)).toBe("on");
    expect(phaseOf("", false)).toBe("off");
  });

  it("shows a probe as on", () => {
    expect(phaseOf("probing", true)).toBe("on");
  });
});

describe("what the card says about a place", () => {
  it("names a saved proxy by its address, with its login and last check", () => {
    const p = proxy({ user: "bob", last: { ok: true, latencyMs: 85, place: "Berlin, Germany", cc: "de" } as ProxyView["last"] });
    expect(placeView({ kind: "proxy", id: "p1" }, input({ proxies: [p] }))).toEqual({
      kind: "proxy",
      name: "1.2.3.4:8080",
      cc: "de",
      sub: "login bob · 85 ms when last checked · Berlin, Germany",
    });
  });

  it("puts the address under a proxy that has a name", () => {
    const v = placeView({ kind: "proxy", id: "p1" }, input({ proxies: [proxy({ name: "Home" })] }));
    expect(v?.name).toBe("Home");
    expect(v?.sub).toBe("1.2.3.4:8080 · no login");
  });

  it("says which member of a group is in use while connected through it", () => {
    const g1 = { kind: "group", id: "g1" } as const;
    const status = running({ kind: "list", in_use: "x", can_rotate: true, member: 2 }, g1);
    const v = placeView(g1, input({ groups: [group()], status, connected: g1 }));
    expect(v?.name).toBe("Work");
    expect(v?.sub?.startsWith("Proxy 3 of 12 · ")).toBe(true);
  });

  it("says nothing of a member when not connected through that group", () => {
    const v = placeView({ kind: "group", id: "g1" }, input({ groups: [group()] }));
    expect(v?.sub?.startsWith("Proxy ")).toBe(false);
  });

  it("names a free place by its country, or as the fastest anywhere", () => {
    expect(placeView({ kind: "free", country: "", socks5: false }, input())).toMatchObject({ name: "Free · fastest anywhere", cc: undefined });
    expect(placeView({ kind: "free", country: "", socks5: true }, input())?.sub).toBe("A public SOCKS5 exit, swapped for a fresh one when it dies");
  });

  it("says when the free proxy in use was swapped in for the one picked", () => {
    const free = { kind: "free", country: "", socks5: false, exit: "5.6.7.8:3128" } as const;
    const status = running({ kind: "pool", in_use: "http://9.9.9.9:80", can_rotate: true }, free);
    expect(placeView(free, input({ status, connected: free }))?.sub).toBe("Now through 9.9.9.9:80, swapped in for the one you picked");
  });

  it("falls back to what the relay says when the place is not read yet", () => {
    const status = running({ kind: "list", in_use: "x", size: 40, rotation: "every connection", can_rotate: true });
    expect(placeView({ kind: "group", id: "gone" }, input({ status }))).toEqual({ kind: "group", name: "A group of 40 proxies", sub: "every connection" });
  });

  it("shows nothing with no place and no relay", () => {
    expect(placeView(null, input())).toBeNull();
  });
});
