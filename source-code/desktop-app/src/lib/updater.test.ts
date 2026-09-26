import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE,
  lastCheckedAt,
  manualDownloadUrl,
  nobodyUsing,
  pillLabel,
  reduce,
  shouldOffer,
  skipVersion,
  skippedVersion,
  type UpdateInfo,
  type UpdateState,
} from "./updater";

/* The policy layer of the updater, without Tauri. What is tested here is what
   the person sees and when: the pill appears only once the bytes are on disk,
   a failed background download stays silent, a failed install after a click
   does not, and a skipped version stays skipped until they ask again. */

const info: UpdateInfo = { version: "0.3.0", currentVersion: "0.2.0", notes: "Fixes the SOCKS4 grade." };

describe("reduce", () => {
  it("downloads in the background the moment a version is found, and shows nothing", () => {
    const s = reduce(IDLE, { type: "found", info });
    expect(s.stage).toBe("downloading");
    expect(pillLabel(s)).toBeNull();
  });

  it("shows the pill only when the download has finished", () => {
    const s = reduce(reduce(IDLE, { type: "found", info }), { type: "downloaded" });
    expect(s.stage).toBe("ready");
    expect(pillLabel(s)).toBe("Restart to update");
  });

  it("a failed background download goes back to idle without a word", () => {
    const s = reduce(reduce(IDLE, { type: "found", info }), { type: "download_failed" });
    expect(s).toEqual(IDLE);
    expect(pillLabel(s)).toBeNull();
  });

  it("a failed install after the click is shown, with the error", () => {
    let s: UpdateState = reduce(IDLE, { type: "found", info });
    s = reduce(s, { type: "downloaded" });
    s = reduce(s, { type: "install_requested" });
    expect(s.stage).toBe("installing");
    expect(pillLabel(s)).toBe("Restarting");
    s = reduce(s, { type: "install_failed", error: "signature mismatch" });
    expect(s.stage).toBe("failed");
    expect(s.error).toBe("signature mismatch");
    expect(pillLabel(s)).toBe("Update failed");
  });

  it("install can only be requested once the bytes are ready", () => {
    const downloading = reduce(IDLE, { type: "found", info });
    expect(reduce(downloading, { type: "install_requested" })).toBe(downloading);
    expect(reduce(IDLE, { type: "install_requested" })).toBe(IDLE);
  });

  it("dismissing clears everything", () => {
    const ready = reduce(reduce(IDLE, { type: "found", info }), { type: "downloaded" });
    expect(reduce(ready, { type: "dismissed" })).toEqual(IDLE);
  });

  it("a stray 'downloaded' outside of a download changes nothing", () => {
    expect(reduce(IDLE, { type: "downloaded" })).toBe(IDLE);
  });
});

describe("shouldOffer", () => {
  it("offers a version nobody skipped", () => {
    expect(shouldOffer("0.3.0", null, false)).toBe(true);
    expect(shouldOffer("0.3.0", "0.2.5", false)).toBe(true);
  });

  it("stays quiet about the exact version that was skipped", () => {
    expect(shouldOffer("0.3.0", "0.3.0", false)).toBe(false);
  });

  it("a manual check takes even a skipped version", () => {
    expect(shouldOffer("0.3.0", "0.3.0", true)).toBe(true);
  });
});

describe("storage", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });

  it("remembers the skipped version", () => {
    expect(skippedVersion()).toBeNull();
    skipVersion("0.3.0");
    expect(skippedVersion()).toBe("0.3.0");
  });

  it("reads the last check time as a number, or null", () => {
    expect(lastCheckedAt()).toBeNull();
    store.set("hproxy-checker-last-update-check", "1700000000000");
    expect(lastCheckedAt()).toBe(1700000000000);
    store.set("hproxy-checker-last-update-check", "garbage");
    expect(lastCheckedAt()).toBeNull();
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(skippedVersion()).toBeNull();
    expect(() => skipVersion("0.3.0")).not.toThrow();
  });
});

/* The app lives in the tray, so an update that waits for a click may wait
   forever. It installs itself only when nobody is using the app: every one of
   these facts has to say so (src-tauri/src/update.rs checks them again). */
describe("nobodyUsing", () => {
  const hidden = { window_visible: false, connected: false, other_copies: 0 };

  it("installs a downloaded update when the window is in the tray and nothing runs", () => {
    expect(nobodyUsing("ready", hidden, false)).toBe(true);
  });

  it("waits while anything says someone is there", () => {
    expect(nobodyUsing("downloading", hidden, false)).toBe(false);
    expect(nobodyUsing("ready", { ...hidden, window_visible: true }, false)).toBe(false);
    expect(nobodyUsing("ready", { ...hidden, connected: true }, false)).toBe(false);
    expect(nobodyUsing("ready", hidden, true)).toBe(false);
    // An AI assistant's tool is the same program, and the installer would end it.
    expect(nobodyUsing("ready", { ...hidden, other_copies: 1 }, false)).toBe(false);
    expect(nobodyUsing("ready", { ...hidden, other_copies: null }, false)).toBe(false);
    expect(nobodyUsing("ready", null, false)).toBe(false);
  });
});

/* "Download it manually" after a failed update: Windows gets the newest
   installer from hproxy.com, the folder the app updates from; the platforms
   built on GitHub still go there. */
describe("manualDownloadUrl", () => {
  it("hands Windows the newest installer on hproxy.com", () => {
    const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
    expect(manualDownloadUrl(edge)).toBe("https://hproxy.com/downloads/desktop/hproxy-windows-x64-setup.exe");
  });

  it("sends the other platforms to the releases page", () => {
    expect(manualDownloadUrl("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toMatch(/github\.com/);
    expect(manualDownloadUrl("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36")).toMatch(/github\.com/);
    expect(manualDownloadUrl("")).toMatch(/github\.com/);
  });
});
