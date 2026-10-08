/* In-app updates while the app runs.
 *
 * Why this exists at all: a proxy checker is a security-adjacent tool, and the
 * things most likely to need fixing are the things users cannot see are broken.
 * If the anonymity judge moves, or a grading bug lands, everyone who already
 * downloaded the app keeps getting confidently wrong answers until they happen
 * to revisit the download page. Shipping a fix is worthless if it does not
 * reach the people running the old build.
 *
 * Updates come from hproxy.com (src-tauri/src/update.rs, published by the
 * maintainers' release tool). Every one is minisign-verified against the public
 * key compiled into the binary, so a hijacked download host cannot push a
 * payload to our users, and it must be signed after this build was released,
 * so it cannot hand them an old build of ours either. An unsigned auto-updater
 * would be a far worse liability than none.
 *
 * The first chance is the start: a newer version is installed before the
 * screens open (components/StartGate.tsx, lib/startGate.ts). This module is
 * what happens after that, while the app runs:
 *
 * 1. NEVER interrupt work. The download happens in the background the moment a
 *    newer version is found. While someone uses the app, installing waits for
 *    their click on "Restart to update", or for the next start.
 * 2. ALWAYS arrive. The app lives in the tray, so someone can keep it hidden
 *    for weeks and never see that click or a start. When nobody is using it
 *    (the window hidden, no connection, no check running, no other copy of the
 *    app's own program running) it installs itself silently and the new version
 *    comes back to the tray (installWhileNobodyUses, src-tauri/src/update.rs).
 *    An AI assistant's tool is its own copy on Windows (src-tauri/src/tool.rs),
 *    so it neither holds an update back nor is ended by one.
 * 3. NEVER nag. Nothing is shown while checking or downloading, nothing when
 *    the download fails (the next timer check simply tries again). The one
 *    surface is a pill in the title bar once the bytes are ready.
 * 4. ALWAYS say what changed. The pill opens a panel with the release notes.
 *
 * The click path stops Connect before installing, so the system proxy is put
 * back by the normal path; if a relay were ever left, the new version's start
 * puts the setting back first (connect::repair_on_start). The quiet path only
 * runs with nothing connected, and restores in the installer's before-exit
 * hook as well.
 */

import {
  connectStatus,
  connectStop,
  installChannel,
  isTauri,
  updateCheck,
  updateDownload,
  updateForget,
  updateIdle,
  updateInstall,
  updateInstallQuietly,
  type UpdateIdle,
  type UpdateInfo,
} from "./tauri";

export type { UpdateInfo };

export type UpdateStage = "none" | "downloading" | "ready" | "installing" | "failed";

export type UpdateState = {
  stage: UpdateStage;
  /** The version in flight. Null only in stage "none". */
  info: UpdateInfo | null;
  /** Why installing failed, for the panel. Null unless stage is "failed". */
  error: string | null;
};

export type UpdateEvent =
  | { type: "found"; info: UpdateInfo }
  | { type: "downloaded" }
  | { type: "download_failed" }
  | { type: "install_requested" }
  | { type: "install_failed"; error: string }
  | { type: "dismissed" };

export const IDLE: UpdateState = { stage: "none", info: null, error: null };

/** The state machine, kept pure so it can be tested without Tauri.
 *
 *  A failed download goes back to "none" without a word: the person did not
 *  ask for anything, so there is nothing to report, and the next timer check
 *  tries again. A failed install is different, they clicked, so the error is
 *  shown with a way out. */
export function reduce(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case "found":
      return { stage: "downloading", info: event.info, error: null };
    case "downloaded":
      return state.stage === "downloading" ? { ...state, stage: "ready" } : state;
    case "download_failed":
      return IDLE;
    case "install_requested":
      return state.stage === "ready" ? { ...state, stage: "installing", error: null } : state;
    case "install_failed":
      return { ...state, stage: "failed", error: event.error };
    case "dismissed":
      return IDLE;
  }
}

/** The title bar's pill: null means nothing is shown. */
export function pillLabel(state: UpdateState): string | null {
  switch (state.stage) {
    case "ready":
      return "Restart to update";
    case "installing":
      return "Restarting";
    case "failed":
      return "Update failed";
    default:
      return null;
  }
}

/* ── storage ─────────────────────────────────────────────────────────────── */

const LAST_CHECK_KEY = "hproxy-checker-last-update-check";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or storage disabled: worst case the time is not shown */
  }
}

export function lastCheckedAt(): number | null {
  const raw = read(LAST_CHECK_KEY);
  return raw ? Number(raw) || null : null;
}

/* ── the live state, one store for the whole window ──────────────────────── */

/** Re-check on a timer, not just at start. This app is the kind that stays
 *  open all day, so a start-only check means a long-running session never
 *  learns about a fix at all. Six hours is often enough to matter and rare
 *  enough to be invisible. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let state: UpdateState = IDLE;
const listeners = new Set<() => void>();

function dispatch(event: UpdateEvent): void {
  const next = reduce(state, event);
  if (next === state) return;
  state = next;
  listeners.forEach((fn) => fn());
}

export function getUpdateState(): UpdateState {
  return state;
}

export function subscribeUpdateState(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The version this build reports, for display and for "you're up to date". */
export async function currentVersion(): Promise<string> {
  if (!isTauri()) return "dev";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "unknown";
  }
}

/**
 * Look for a newer release and, when there is one, start downloading it in the
 * background. Resolves to the version found, or null when there is nothing to
 * act on for any reason: offline, the list unreachable, already current, or a
 * copy that does not update itself (its store or its owner updates it, and the
 * version list speaks to it: lib/versions.ts). Never throws.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const channel = await installChannel();
  if (!channel) return null;
  try {
    const info = await updateCheck();
    write(LAST_CHECK_KEY, String(Date.now()));
    if (!info) return null;
    // The same version is already downloaded or on its way: keep that one.
    if (state.info?.version === info.version && state.stage !== "failed") return info;
    void download(info);
    return info;
  } catch {
    return null;
  }
}

async function download(info: UpdateInfo): Promise<void> {
  dispatch({ type: "found", info });
  try {
    await updateDownload();
    dispatch({ type: "downloaded" });
  } catch (e) {
    console.warn("update download failed, will try again later:", message(e));
    dispatch({ type: "download_failed" });
  }
}

/**
 * Install the downloaded version and restart. Only ever called from a click.
 *
 * Connect is stopped first so the system proxy is put back by the normal path.
 * On Windows the install does not return: the installer takes over, shows its
 * progress and starts the new version. Elsewhere the app swaps its files and
 * restarts itself.
 */
export async function restartToUpdate(): Promise<void> {
  if (state.stage !== "ready") return;
  dispatch({ type: "install_requested" });
  try {
    const status = await connectStatus();
    if (status.running) await connectStop();
    await updateInstall();
  } catch (e) {
    dispatch({ type: "install_failed", error: message(e) || "The update could not be installed." });
  }
}

/** How often a downloaded update looks for a moment when nobody is using the app. */
export const QUIET_INSTALL_EVERY_MS = 10 * 60 * 1000;

/** Whether to install the downloaded update now, silently: it is ready, the
 *  window is hidden, nothing is connected, no check runs, and no other copy of
 *  the program runs (the tool an AI assistant started is this same program,
 *  and the installer ends every copy). Unknown copies count as someone. */
export function nobodyUsing(stage: UpdateStage, idle: UpdateIdle | null, checking: boolean): boolean {
  return (
    stage === "ready" && idle !== null && !idle.window_visible && !idle.connected && idle.other_copies === 0 && !checking
  );
}

/** Install the downloaded update if nobody is using the app. The app checks
 *  the same facts again before and after its own download (update.rs), so a
 *  person who comes back in the meantime stops it. Never throws. */
export async function installWhileNobodyUses(checking: boolean): Promise<void> {
  if (state.stage !== "ready") return;
  try {
    if (!nobodyUsing(state.stage, await updateIdle(), checking)) return;
    await updateInstallQuietly();
  } catch (e) {
    console.warn("the quiet update did not happen, the next try is in ten minutes:", message(e));
  }
}

/** After a failed install: fetch the list again and download afresh. */
export async function retryUpdate(): Promise<void> {
  try {
    await updateForget();
  } catch {
    /* nothing kept: nothing to forget */
  }
  dispatch({ type: "dismissed" });
  await checkForUpdate();
}

/** The newest Windows installer, always under this name, in the folder on
 *  hproxy.com the app updates from (src-tauri/src/update.rs, STABLE_LIST).
 *  Published by the maintainers' release tool. */
export const WINDOWS_INSTALLER_URL = "https://hproxy.com/downloads/desktop/hproxy-windows-x64-setup.exe";

/** macOS, Linux and Android files: the releases page, until hproxy.com carries them too. */
const RELEASES_PAGE = "https://github.com/hproxy-com/proxy-all-in-one-tool/releases/latest";

/** Where the newest version can be had by hand on this platform. */
export function manualDownloadUrl(userAgent: string): string {
  return /Windows/i.test(userAgent) ? WINDOWS_INSTALLER_URL : RELEASES_PAGE;
}

/** The app's page in the Microsoft Store (Partner Center product 9NPDSV0K3J1X), where the
    Store copy's owner can look for an update. */
export const MICROSOFT_STORE_URL = "https://apps.microsoft.com/detail/9NPDSV0K3J1X";

/** The app's page on Google Play. Its package name is the Android build's `applicationId`
    (src-tauri/gen/android/app/build.gradle.kts), fixed for good when the Play app was created;
    it is not tauri.conf.json's identifier, which stays the desktop app's. A copy that Play
    installed is only ever sent here, never to a download: Play's rules. */
export const GOOGLE_PLAY_URL = "https://play.google.com/store/apps/details?id=com.hproxy.app";

/** A store's page for the app, where the copy it installed can look for an update. */
export async function openStorePage(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    /* ignore */
  }
}

/** The newest version by hand, for a copy that cannot install it itself. */
export async function openManualDownload(): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(manualDownloadUrl(typeof navigator === "undefined" ? "" : navigator.userAgent));
  } catch {
    /* ignore */
  }
}
