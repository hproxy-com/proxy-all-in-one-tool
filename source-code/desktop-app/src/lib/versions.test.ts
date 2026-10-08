import { describe, expect, it } from "vitest";
import { channelWay, noticeFor, OVERDUE_MS, updatesItself, type Channel, type Verdict } from "./versions";

/* When a copy hears about a new version from the version list. What is tested here is what the
   person sees: nothing while they are current, the notice once their channel has a newer
   version, and for a copy that updates itself, only once its own update is days late. */

const NOW = Date.parse("2026-10-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const newer = (released: number, required = false): Verdict => ({
  current: "0.2.4",
  newer: "0.2.5",
  required,
  notes: "One box.",
  date: new Date(released).toISOString(),
});
const current: Verdict = { current: "0.2.5", newer: null, required: false };

const EVERY: Channel[] = [
  "windows",
  "macos",
  "linux-appimage",
  "linux-deb",
  "linux-rpm",
  "microsoft-store",
  "google-play",
  "apk",
  "app-store",
];

describe("noticeFor", () => {
  it("says nothing to a copy that is current, or when nothing is known", () => {
    for (const channel of EVERY) {
      expect(noticeFor(channel, current, NOW)).toBeNull();
      expect(noticeFor(channel, null, NOW)).toBeNull();
    }
  });

  it("tells a store's copy and a package at once", () => {
    for (const channel of ["microsoft-store", "google-play", "apk", "linux-deb", "linux-rpm"] as Channel[]) {
      expect(noticeFor(channel, newer(NOW - 60_000), NOW)).toEqual({ channel, verdict: newer(NOW - 60_000) });
    }
  });

  it("leaves a copy that updates itself to its updater, until that update is days late", () => {
    for (const channel of ["windows", "macos", "linux-appimage"] as Channel[]) {
      expect(noticeFor(channel, newer(NOW - DAY), NOW)).toBeNull();
      expect(noticeFor(channel, newer(NOW - OVERDUE_MS + 60_000), NOW)).toBeNull();
      expect(noticeFor(channel, newer(NOW - OVERDUE_MS - 60_000), NOW)?.channel).toBe(channel);
    }
  });

  it("does not call a copy late when the release date cannot be read", () => {
    expect(noticeFor("windows", { ...newer(NOW - 10 * DAY), date: undefined }, NOW)).toBeNull();
    expect(noticeFor("windows", { ...newer(NOW - 10 * DAY), date: "not a date" }, NOW)).toBeNull();
  });

  it("keeps a required version's word", () => {
    expect(noticeFor("microsoft-store", newer(NOW, true), NOW)?.verdict.required).toBe(true);
  });
});

describe("updatesItself", () => {
  it("is the downloads for Windows, macOS and the AppImage, nothing else", () => {
    expect(EVERY.filter(updatesItself)).toEqual(["windows", "macos", "linux-appimage"]);
  });
});

describe("channelWay", () => {
  it("gives every channel with a way a button and a line", () => {
    for (const channel of EVERY.filter((c) => c !== "app-store")) {
      const way = channelWay(channel);
      expect(way?.button, channel).toBeTruthy();
      expect(way?.line, channel).toBeTruthy();
    }
    expect(channelWay("app-store"), "no iPhone app is published").toBeNull();
  });

  it("sends a Google Play copy to Google Play, never to a download", () => {
    expect(channelWay("google-play")?.button).toBe("Open Google Play");
    expect(channelWay("google-play")?.line).not.toMatch(/APK|download/i);
  });

  it("tells a late self-updating copy what happened before it offers the download", () => {
    expect(channelWay("windows")?.line).toMatch(/could not update itself/);
    expect(channelWay("windows")?.button).toBe("Download");
  });
});
