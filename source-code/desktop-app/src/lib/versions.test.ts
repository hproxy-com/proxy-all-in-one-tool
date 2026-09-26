import { describe, expect, it } from "vitest";
import { channelWay, noticeFor, type Channel, type Verdict } from "./versions";

/* When a copy that its store or its owner updates hears about a new version. What is tested
   here is what the person sees: nothing while they are current, the notice once a newer
   version is out, silence for a version they skipped until they ask, and no way to skip one
   that is required. */

const newer = (required = false): Verdict => ({ current: "0.2.3", newer: "0.2.4", required, notes: "One box." });
const current: Verdict = { current: "0.2.4", newer: null, required: false };

describe("noticeFor", () => {
  it("says nothing to a copy that is current, or when nothing is known", () => {
    expect(noticeFor("microsoft-store", current, null, false)).toBeNull();
    expect(noticeFor("microsoft-store", null, null, true)).toBeNull();
  });

  it("names the newer version and the channel that delivers it", () => {
    expect(noticeFor("google-play", newer(), null, false)).toEqual({ channel: "google-play", verdict: newer() });
  });

  it("keeps a skipped version quiet on the timer, and shows it when the person asks", () => {
    expect(noticeFor("apk", newer(), "0.2.4", false)).toBeNull();
    expect(noticeFor("apk", newer(), "0.2.4", true)).not.toBeNull();
    // Skipping one version is not skipping the next.
    expect(noticeFor("apk", { ...newer(), newer: "0.2.5" }, "0.2.4", false)).not.toBeNull();
  });

  it("never lets a required version be skipped", () => {
    expect(noticeFor("microsoft-store", newer(true), "0.2.4", false)?.verdict.required).toBe(true);
  });
});

describe("channelWay", () => {
  it("gives every store and the APK a button, and leaves the download to its own updater", () => {
    const stores: Channel[] = ["microsoft-store", "google-play", "apk"];
    for (const channel of stores) {
      const way = channelWay(channel);
      expect(way?.button).toBeTruthy();
      expect(way?.line).toBeTruthy();
    }
    expect(channelWay("hproxy.com")).toBeNull();
  });

  it("sends a Google Play copy to Google Play, never to a download", () => {
    expect(channelWay("google-play")?.button).toBe("Open Google Play");
    expect(channelWay("google-play")?.line).not.toMatch(/APK|download/i);
  });
});
