import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, whatLeaves } from "./settings";

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

describe("dark by default (2026-10-05)", () => {
  it("opens dark on a fresh install", () => {
    expect(loadSettings().theme).toBe("midnight");
    expect(DEFAULT_SETTINGS.theme).toBe("midnight");
  });

  /* The app saved its defaults on first run, so a stored "electric" from the
     white days (look d-2026-09-23) is mostly that default, not anyone's
     choice: it moves to dark once. Everything else the person set stays. */
  it("moves settings saved in the white days to dark once, keeping the rest", () => {
    store.set("hproxy-checker-settings", JSON.stringify({ theme: "electric", look: "d-2026-09-23", concurrency: 300, protocols: { socks4: false } }));
    const s = loadSettings();
    expect(s.theme).toBe("midnight");
    expect(s.concurrency).toBe(300);
    expect(s.protocols).toEqual({ http: true, https: true, socks4: false, socks5: true });
  });

  it("moves settings older than that to dark too", () => {
    store.set("hproxy-checker-settings", JSON.stringify({ theme: "electric" }));
    expect(loadSettings().theme).toBe("midnight");
  });

  it("keeps white once it was picked after the move", () => {
    saveSettings({ ...DEFAULT_SETTINGS, theme: "electric" });
    expect(loadSettings().theme).toBe("electric");
    expect(JSON.parse(store.get("hproxy-checker-settings") ?? "{}").look).toBe("dark-2026-10-05");
  });

  it("reads corrupt storage as the defaults", () => {
    store.set("hproxy-checker-settings", "{nope");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

/* The Check welcome says what leaves the computer. It shipped once as
   "Nothing leaves this computer" while the defaults send every address to the
   IP lookup, so the sentence is tied to the two settings that decide it. */
describe("what a check sends off this computer", () => {
  it("names the address lookup with the defaults", () => {
    const line = whatLeaves(DEFAULT_SETTINGS);
    expect(line).toContain("Only the addresses go out");
    expect(line).not.toContain("nothing");
  });

  it("says nothing leaves only when checking is local and the lookup is off", () => {
    expect(whatLeaves({ source: "local", geoLookup: false })).toContain("nothing about your list leaves");
    expect(whatLeaves({ source: "both", geoLookup: false })).toContain("logins included");
    expect(whatLeaves({ source: "api", geoLookup: true })).toContain("logins included");
  });
});
