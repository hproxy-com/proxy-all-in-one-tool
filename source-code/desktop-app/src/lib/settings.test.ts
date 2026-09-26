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

describe("white by default (2026-09-23)", () => {
  it("opens white on a fresh install", () => {
    expect(loadSettings().theme).toBe("electric");
    expect(DEFAULT_SETTINGS.theme).toBe("electric");
  });

  /* The app saved its defaults on first run, so a stored "midnight" from
     before look D is the old default, not anyone's choice: it moves to white
     once. Everything else the person set stays. */
  it("moves settings saved before look D to white once, keeping the rest", () => {
    store.set("hproxy-checker-settings", JSON.stringify({ theme: "midnight", concurrency: 300, protocols: { socks4: false } }));
    const s = loadSettings();
    expect(s.theme).toBe("electric");
    expect(s.concurrency).toBe(300);
    expect(s.protocols).toEqual({ http: true, https: true, socks4: false, socks5: true });
  });

  it("keeps dark once it was picked in look D", () => {
    saveSettings({ ...DEFAULT_SETTINGS, theme: "midnight" });
    expect(loadSettings().theme).toBe("midnight");
    expect(JSON.parse(store.get("hproxy-checker-settings") ?? "{}").look).toBe("d-2026-09-23");
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
