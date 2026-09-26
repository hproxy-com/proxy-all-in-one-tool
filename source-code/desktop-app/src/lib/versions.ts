/* A new version, for every copy, whatever installed it.
 *
 * The download from hproxy.com updates itself (lib/updater.ts). A copy from the Microsoft Store
 * or Google Play is updated by its store, and an APK installed by hand by its owner, so nothing
 * used to tell those copies that a fix was out. Now every copy reads hproxy.com's version list
 * on the updater's timer (src-tauri/src/versions.rs), naming the channel it updates from, and
 * once that channel has a newer version the title bar shows the updater's pill with this copy's
 * own way to get it. A store publishes after its review, so a store's copy hears about a version
 * only when the store has it, never while it is still being reviewed.
 *
 * The list also carries a minimum: the oldest version that still works as it should. Below it
 * the update is required, the pill says so and the sheet has no "skip". The list never says
 * where to download from: every channel's way is fixed here, so a changed file on the server
 * can at most show a wrong notice.
 */

import { isMobile, isStoreInstall, isTauri } from "./tauri";
import {
  GOOGLE_PLAY_BUILD,
  GOOGLE_PLAY_URL,
  MICROSOFT_STORE_URL,
  openManualDownload,
  openStorePage,
  skippedVersion,
  skipVersion,
} from "./updater";

/** Where this copy came from, which is where its updates come from. */
export type Channel = "hproxy.com" | "microsoft-store" | "google-play" | "apk";

/** What the version list says about this copy (src-tauri/src/versions.rs, hproxy_api::versions). */
export type Verdict = {
  current: string;
  newer: string | null;
  required: boolean;
  notes?: string;
  date?: string;
};

export type Notice = { channel: Channel; verdict: Verdict };

export async function installedFrom(): Promise<Channel | null> {
  if (!isTauri()) return null;
  if (isMobile()) return GOOGLE_PLAY_BUILD ? "google-play" : "apk";
  return (await isStoreInstall()) ? "microsoft-store" : "hproxy.com";
}

/** Whether a verdict becomes a notice. A version the person skipped stays quiet on the timer's
 *  checks, like the updater's; a required one never does, and neither does a manual check. */
export function noticeFor(channel: Channel, verdict: Verdict | null, skipped: string | null, manual: boolean): Notice | null {
  if (!verdict?.newer) return null;
  if (!verdict.required && !manual && skipped === verdict.newer) return null;
  return { channel, verdict };
}

/** How this channel gets the new version: the words on the sheet's button and on the line
 *  above it. The download from hproxy.com has its own sheet (the updater's). */
export function channelWay(channel: Channel): { button: string; line: string; run: () => Promise<void> } | null {
  switch (channel) {
    case "microsoft-store":
      return {
        button: "Open the Microsoft Store",
        line: "The Microsoft Store installs it: open HProxy's page there and choose Update.",
        run: () => openStorePage(MICROSOFT_STORE_URL),
      };
    case "google-play":
      return {
        button: "Open Google Play",
        line: "Google Play installs it: open HProxy's page there and tap Update.",
        run: () => openStorePage(GOOGLE_PLAY_URL),
      };
    case "apk":
      return {
        button: "Download",
        line: "Download the new APK and open it: it installs over this one and keeps your saved proxies.",
        run: () => openManualDownload(),
      };
    case "hproxy.com":
      return null;
  }
}

/* ── the live notice, one for the whole window ───────────────────────────── */

let notice: Notice | null = null;
const listeners = new Set<() => void>();

function set(next: Notice | null): void {
  if (JSON.stringify(next) === JSON.stringify(notice)) return;
  notice = next;
  listeners.forEach((fn) => fn());
}

export function getVersionNotice(): Notice | null {
  return notice;
}

export function subscribeVersionNotice(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Ask the version list. Never throws; offline or an unreadable list keeps the notice as it was. */
export async function checkVersions(manual = false): Promise<Notice | null> {
  const channel = await installedFrom();
  if (!channel) return null;
  let verdict: Verdict | null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    verdict = await invoke<Verdict | null>("versions_check", { channel });
  } catch {
    return notice;
  }
  // Null means nothing is known (offline, the list missing, a development build): keep what is
  // shown. An answer that this copy is current clears it.
  if (verdict === null) return notice;
  set(noticeFor(channel, verdict, skippedVersion(), manual));
  return notice;
}

/** "Skip this version" on a store's notice. A required version cannot be skipped. */
export function skipNotice(): void {
  if (!notice || notice.verdict.required || !notice.verdict.newer) return;
  skipVersion(notice.verdict.newer);
  set(null);
}
