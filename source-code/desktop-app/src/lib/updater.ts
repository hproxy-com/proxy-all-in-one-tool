/* In-app updates.
 *
 * Why this exists at all: a proxy checker is a security-adjacent tool, and the
 * things most likely to need fixing are the things users cannot see are broken.
 * If the anonymity judge moves, or a grading bug lands, everyone who already
 * downloaded the app keeps getting confidently wrong answers until they happen
 * to revisit the download page. Shipping a fix is worthless if it does not
 * reach the people running the old build.
 *
 * Updates come from hproxy.com (the updater endpoint in tauri.conf.json,
 * published by the maintainers' release tool). Every one is minisign-verified
 * against the public key compiled into the binary, so a hijacked download host
 * cannot push a payload to our users, and it must be signed after this build
 * was released, so it cannot hand them an old build of ours either
 * (src-tauri/src/update.rs). An unsigned auto-updater would be a far worse
 * liability than none.
 *
 * The rules this module enforces, and how:
 *
 * 1. NEVER interrupt work. The download happens in the background the moment a
 *    newer version is found. While someone uses the app, installing waits for
 *    their click on "Restart to update". On Windows the plugin ends this
 *    process inside install() and the installer relaunches the app (its own
 *    /R flag); on macOS and Linux install() swaps the bundle and we relaunch.
 * 2. ALWAYS arrive. The app lives in the tray, so someone can keep it hidden
 *    for weeks and never see that click. When nobody is using it (the window
 *    hidden, no connection, no check running, no other copy of the app's own
 *    program running) it installs itself silently and the new version comes
 *    back to the tray (installWhileNobodyUses, src-tauri/src/update.rs).
 *    The new version downloads quietly in the background and disturbs no
 *    one. An AI assistant's tool is its own
 *    copy on Windows (src-tauri/src/tool.rs), so it neither holds an update
 *    back nor is ended by one.
 * 3. NEVER nag. Nothing is shown while checking or downloading, nothing when
 *    the download fails (the next timer check simply tries again), and a
 *    version they skipped stays skipped until a newer one ships. The one
 *    surface is a pill in the title bar once the bytes are ready.
 * 4. ALWAYS say what changed. The pill opens a panel with the release notes.
 *
 * The click path stops Connect before install(), so the system proxy is put
 * back by the normal path; if a relay were ever left, the new version's start
 * puts the setting back first (connect::repair_on_start). The quiet path only
 * runs with nothing connected, and restores in the installer's before-exit
 * hook as well.
 */

import type { Update } from "@tauri-apps/plugin-updater";
import { connectStatus, connectStop, isMobile, isStoreInstall, isTauri, updateIdle, updateInstallQuietly, type UpdateIdle } from "./tauri";

export type UpdateInfo = {
  version: string;
  currentVersion: string;
  notes?: string;
  date?: string;
};

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

/** Whether a version found on the server should be taken. A skipped version is
 *  left alone on the timer's checks; a manual check ("Check for updates") is
 *  the person asking again, so it takes even a skipped one. */
export function shouldOffer(version: string, skipped: string | null, manual: boolean): boolean {
  return manual || skipped !== version;
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

const SKIP_KEY = "hproxy-checker-skipped-version";
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
    /* private mode or storage disabled: worst case we ask again next launch */
  }
}

export function skippedVersion(): string | null {
  return read(SKIP_KEY);
}

/** Dismiss THIS version only. A newer one still surfaces: "not now" must not
 *  silently mean "never again", which is how people end up years behind. */
export function skipVersion(version: string): void {
  write(SKIP_KEY, version);
}

export function lastCheckedAt(): number | null {
  const raw = read(LAST_CHECK_KEY);
  return raw ? Number(raw) || null : null;
}

/* ── the live state, one store for the whole window ──────────────────────── */

/** Re-check on a timer, not just at launch. This app is the kind that stays
 *  open all day, so a launch-only check means a long-running session never
 *  learns about a fix at all. Six hours is often enough to matter and rare
 *  enough to be invisible. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let state: UpdateState = IDLE;
/** The plugin handle whose bytes are downloaded (or downloading). */
let pending: Update | null = null;
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

function toInfo(update: Update): UpdateInfo {
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body?.trim() || undefined,
    date: update.date,
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function release(update: Update | null): Promise<void> {
  try {
    await update?.close();
  } catch {
    /* the resource may already be gone */
  }
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
 * Look for a newer release and, if one should be offered, start downloading it
 * in the background. Resolves to the version found, or null when there is
 * nothing to act on for any reason: offline, endpoint unreachable, already
 * current, or the person skipped this exact version. Never throws.
 *
 * `manual` is true when a human pressed "Check for updates", which takes even
 * a skipped version (asking again is the point).
 */
export async function checkForUpdate(manual = false): Promise<UpdateInfo | null> {
  // Phones update through their store; the updater plugin is not built there.
  // The Microsoft Store copy updates through the Store too (src-tauri/src/store.rs).
  if (!isTauri() || isMobile() || (await isStoreInstall())) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    write(LAST_CHECK_KEY, String(Date.now()));
    if (!update) return null;
    const info = toInfo(update);
    if (!shouldOffer(update.version, skippedVersion(), manual)) {
      await release(update);
      return null;
    }
    // The same version is already downloaded or on its way: keep that one.
    if (pending && state.info?.version === update.version && state.stage !== "failed") {
      await release(update);
      return info;
    }
    void download(update);
    return info;
  } catch {
    return null;
  }
}

async function download(update: Update): Promise<void> {
  await release(pending);
  pending = update;
  dispatch({ type: "found", info: toInfo(update) });
  try {
    await update.download();
    dispatch({ type: "downloaded" });
  } catch (e) {
    console.warn("update download failed, will try again later:", message(e));
    pending = null;
    dispatch({ type: "download_failed" });
  }
}

/**
 * Install the downloaded version and restart. Only ever called from a click.
 *
 * Connect is stopped first so the system proxy is put back by the normal path.
 * On Windows `install()` does not return: the plugin starts the installer and
 * exits this process, and the installer relaunches the app. Elsewhere it swaps
 * the bundle and returns, and we relaunch.
 */
export async function restartToUpdate(): Promise<void> {
  if (!pending || state.stage !== "ready") return;
  dispatch({ type: "install_requested" });
  try {
    const status = await connectStatus();
    if (status.running) await connectStop();
    await pending.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
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

/** "Skip this version": forget the download and stay quiet until a newer one. */
export async function dismissUpdate(): Promise<void> {
  if (state.info) skipVersion(state.info.version);
  await release(pending);
  pending = null;
  dispatch({ type: "dismissed" });
}

/** After a failed install: fetch the manifest again and download afresh. */
export async function retryUpdate(): Promise<void> {
  await release(pending);
  pending = null;
  dispatch({ type: "dismissed" });
  await checkForUpdate(true);
}

/** The newest Windows installer, always under this name, in the folder on
 *  hproxy.com the app updates from (tauri.conf.json, the updater endpoint).
 *  Published by the maintainers' release tool. */
export const WINDOWS_INSTALLER_URL = "https://hproxy.com/downloads/desktop/hproxy-windows-x64-setup.exe";

/** macOS, Linux and Android are built on GitHub (.github/workflows/release.yml)
 *  until they are published on hproxy.com too. */
const RELEASES_PAGE = "https://github.com/hproxy-com/proxy-all-in-one-tool/releases/latest";

/** Where the newest version can be had by hand on this platform. */
export function manualDownloadUrl(userAgent: string): string {
  return /Windows/i.test(userAgent) ? WINDOWS_INSTALLER_URL : RELEASES_PAGE;
}

/** The app's page in the Microsoft Store (Partner Center product 9NPDSV0K3J1X), where the
    Store copy's owner can look for an update. */
export const MICROSOFT_STORE_URL = "https://apps.microsoft.com/detail/9NPDSV0K3J1X";

/** The build uploaded to Google Play (scripts/android-play.mjs sets VITE_APP_STORE). Play
    updates that copy, and Play forbids pointing its users to a newer package anywhere else,
    so this copy offers its Play page instead of the releases page. */
export const GOOGLE_PLAY_BUILD = import.meta.env.VITE_APP_STORE === "google-play";

/** The app's page on Google Play: the package name is tauri.conf.json's identifier. */
export const GOOGLE_PLAY_URL = "https://play.google.com/store/apps/details?id=com.hproxy.checker";

/** A store's page for the app, where the copy it installed can look for an update. */
export async function openStorePage(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    /* ignore */
  }
}

/** Fallback when the in-app path fails: the newest installer, by hand, rather
 *  than a dead end. */
export async function openManualDownload(): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(manualDownloadUrl(typeof navigator === "undefined" ? "" : navigator.userAgent));
  } catch {
    /* ignore */
  }
}
