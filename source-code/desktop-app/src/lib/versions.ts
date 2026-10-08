/* A new version, for every copy, whatever installed it.
 *
 * Every copy reads hproxy.com's version list on the updater's timer (src-tauri/src/versions.rs),
 * naming the channel it updates from (src-tauri/src/channel.rs), and once that channel has a
 * newer version the title bar shows a pill with this copy's own way to get it. A store publishes
 * after its review, so a store's copy hears about a version only when the store has it, never
 * while it is still being reviewed.
 *
 * A copy that installs its own updates (the downloads for Windows, macOS and the AppImage) hears
 * from the list only when its own update is days late: its updater is blocked (an antivirus
 * holding the installer, a firewall) or cannot trust the files any more. The list needs no key,
 * so it still reaches that copy, with a download button.
 *
 * The list also carries a minimum: the oldest version that still works as it should. Below it
 * the update is required: the pill turns red and says so. The list never says where to download
 * from: every channel's way is fixed here, so a changed file on the server can at most show a
 * wrong notice.
 */

import type { Channel } from "./tauri";
import { installChannel } from "./tauri";
import { GOOGLE_PLAY_URL, MICROSOFT_STORE_URL, openManualDownload, openStorePage } from "./updater";

export type { Channel };

/** What the version list says about this copy (src-tauri/src/versions.rs, hproxy_api::versions). */
export type Verdict = {
  current: string;
  newer: string | null;
  required: boolean;
  notes?: string;
  date?: string;
};

export type Notice = { channel: Channel; verdict: Verdict };

/** The copies that install their own updates from hproxy.com (src-tauri/src/channel.rs). */
export function updatesItself(channel: Channel): boolean {
  return channel === "windows" || channel === "macos" || channel === "linux-appimage";
}

/** How late a self-installed update may be before the list speaks up: three days. */
export const OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;

/** Whether a verdict becomes a notice for a copy from `channel`, at the time `now`. */
export function noticeFor(channel: Channel, verdict: Verdict | null, now: number): Notice | null {
  if (!verdict?.newer) return null;
  if (updatesItself(channel)) {
    // A date that cannot be read says nothing about lateness: the updater keeps the word.
    const released = verdict.date ? Date.parse(verdict.date) : Number.NaN;
    if (!(now - released > OVERDUE_MS)) return null;
  }
  return { channel, verdict };
}

/** How this channel gets the new version: the words on the button and on the line above it.
 *  Null where no way exists yet (an iPhone copy: no iPhone app is published). */
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
        line: "Download the new version and open it: it installs over this one and keeps your saved proxies.",
        run: () => openManualDownload(),
      };
    case "linux-deb":
    case "linux-rpm":
      return {
        button: "Download",
        line: "Download the new package and install it over this one: your saved proxies stay.",
        run: () => openManualDownload(),
      };
    case "windows":
    case "macos":
    case "linux-appimage":
      return {
        button: "Download",
        line: "This copy could not update itself. Download the new version and install it over this one: your saved proxies stay.",
        run: () => openManualDownload(),
      };
    case "app-store":
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

/** Ask the version list. Null when nothing is known (offline, the list missing, a development
 *  build). Never throws. */
export async function versionVerdict(): Promise<Verdict | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<Verdict | null>("versions_check");
  } catch {
    return null;
  }
}

/** Ask the version list and update the notice. Offline or an unreadable list keeps the notice as
 *  it was; an answer that this copy is current clears it. */
export async function checkVersions(): Promise<Notice | null> {
  const channel = await installChannel();
  if (!channel) return null;
  const verdict = await versionVerdict();
  if (verdict === null) return notice;
  set(noticeFor(channel, verdict, Date.now()));
  return notice;
}
