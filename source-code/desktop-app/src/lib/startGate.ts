/* The start: a newer version first, then the app.
 *
 * The maintainer's word (2026-09-27), about the apps on his phone: "every time I open an app that has an
 * update ... it requires me to install it before I can start it". So every copy looks for a newer
 * version when it opens, before its screens, and takes it the way its channel allows
 * (src-tauri/src/channel.rs):
 *
 *   the downloads (Windows, macOS, AppImage)  download, install, the new version opens
 *                                             (src-tauri/src/update.rs, `update_at_start`)
 *   the Microsoft Store copy                  the Store's own update window
 *                                             (src-tauri/src/store.rs, `store_update_at_start`)
 *   an APK, a .deb, an .rpm                   a full screen "Version x is out" with Download:
 *                                             nothing may install a package for them
 *   Google Play                               Play's own full-screen update, from the Android code
 *                                             (MainActivity.kt); nothing to do here
 *
 * It never locks anyone out, because a proxy tool that cannot open without our server is a tool
 * that fails exactly when someone needs it: no answer within a few seconds, no internet, a
 * download that stalls, a "no" in the Store's window, and the app opens as it is.
 *
 * Nothing shows during the first moment of the look: most starts find nothing, and a screen that
 * flashes by on every start is worse than none.
 */

import { versionVerdict, updatesItself, type Channel, type Verdict } from "./versions";
import {
  installChannel,
  isTauri,
  onUpdateEvents,
  storeUpdateAtStart,
  updateAtStart,
  type UpdateInfo,
  type UpdateProgress,
} from "./tauri";

export type GateView =
  /** Looking, nothing drawn yet. */
  | { stage: "waiting" }
  /** Looking, and it takes a moment: "Looking for a new version". */
  | { stage: "checking" }
  | { stage: "downloading"; info: UpdateInfo; progress: UpdateProgress | null }
  | { stage: "installing"; info: UpdateInfo }
  /** The Microsoft Store's own update window is open. */
  | { stage: "store" }
  /** A copy nothing may update for its owner: the new version, and a Download button. */
  | { stage: "new-version"; channel: Channel; verdict: Verdict }
  | { stage: "open" };

/** Nothing is drawn while a look is younger than this. */
export const SHOW_AFTER_MS = 400;
/** The longest a start waits for an answer before it opens anyway. The Rust side gives up on its
 *  own after four seconds (update.rs) and six for the Store (store.rs); this is the backstop. */
export const START_BUDGET_MS = 8000;

/** What the start does for a copy from `channel`. */
export function startPlan(channel: Channel | null): "install" | "store" | "tell" | "nothing" {
  if (!channel) return "nothing";
  if (updatesItself(channel)) return "install";
  if (channel === "microsoft-store") return "store";
  if (channel === "apk" || channel === "linux-deb" || channel === "linux-rpm") return "tell";
  return "nothing";
}

/** The bar's share, 0 to 1, or null while the size is unknown. */
export function share(progress: UpdateProgress | null): number | null {
  if (!progress?.total) return null;
  return Math.max(0, Math.min(1, progress.downloaded / progress.total));
}

/** Megabytes, one decimal: "3.1 of 4.4 MB". */
export function sizeLine(progress: UpdateProgress | null): string | null {
  if (!progress) return null;
  const mb = (n: number) => (n / 1048576).toFixed(1);
  return progress.total ? `${mb(progress.downloaded)} of ${mb(progress.total)} MB` : `${mb(progress.downloaded)} MB`;
}

/** The browser preview (no Tauri) shows a stage by name for screenshots: `?gate=downloading`. */
export function previewGate(search: string): GateView | null {
  const stage = new URLSearchParams(search).get("gate");
  const info: UpdateInfo = {
    version: "0.2.5",
    currentVersion: "0.2.4",
    notes: "Connect remembers the last proxy you used. The checker names a dead proxy's reason in plain words.",
    date: "2026-09-30T10:00:00Z",
  };
  switch (stage) {
    case "checking":
      return { stage: "checking" };
    case "downloading":
      return { stage: "downloading", info, progress: { downloaded: 2_950_000, total: 4_400_000 } };
    case "installing":
      return { stage: "installing", info };
    case "store":
      return { stage: "store" };
    case "new-version":
    case "required":
      return {
        stage: "new-version",
        channel: "apk",
        verdict: { current: "0.2.4", newer: "0.2.5", required: stage === "required", notes: info.notes ?? undefined, date: info.date ?? undefined },
      };
    default:
      return null;
  }
}

/* ── the live view, one for the whole window ─────────────────────────────── */

let view: GateView = { stage: "waiting" };
const listeners = new Set<() => void>();

function show(next: GateView): void {
  view = next;
  listeners.forEach((fn) => fn());
}

export function getGateView(): GateView {
  return view;
}

export function subscribeGate(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** "Open anyway" on the new-version screen, and every way the look ends. */
export function openApp(): void {
  show({ stage: "open" });
}

function wait<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

let started: Promise<void> | null = null;

/** The look at start, once per window (a second call, as React's development mode makes, joins
 *  the first). Resolves when the app may open, or when the new-version screen is up. */
export function runStartGate(): Promise<void> {
  started ??= look();
  return started;
}

async function look(): Promise<void> {
  if (!isTauri()) {
    const preview = typeof window === "undefined" ? null : previewGate(window.location.search);
    show(preview ?? { stage: "open" });
    return;
  }
  const plan = startPlan(await wait(installChannel(), 2000, null));
  if (plan === "nothing") return openApp();

  // Anything beyond the look's first moment gets a screen; a found version gets its own.
  let moved = false;
  const reveal = setTimeout(() => {
    if (!moved) show({ stage: "checking" });
  }, SHOW_AFTER_MS);
  let found: UpdateInfo | null = null;
  const off = await onUpdateEvents({
    found: (info) => {
      moved = true;
      found = info;
      show({ stage: "downloading", info, progress: null });
    },
    progress: (progress) => {
      if (found) show({ stage: "downloading", info: found, progress });
    },
    installing: () => {
      if (found) show({ stage: "installing", info: found });
    },
    store: () => {
      moved = true;
      show({ stage: "store" });
    },
  });

  try {
    if (plan === "install") {
      // Once a version is found the download may take its time (the Rust side gives up on a
      // stalled one itself); before that, the budget holds.
      const looked = updateAtStart();
      await wait(looked, START_BUDGET_MS, null);
      if (found) await looked.catch(() => null);
    } else if (plan === "store") {
      const asked = storeUpdateAtStart();
      await wait(asked, START_BUDGET_MS, null);
      if (moved) await asked.catch(() => null);
    } else {
      const verdict = await wait(versionVerdict(), START_BUDGET_MS, null);
      const channel = await installChannel();
      if (verdict?.newer && channel) {
        show({ stage: "new-version", channel, verdict });
        return;
      }
    }
  } finally {
    clearTimeout(reveal);
    off();
  }
  openApp();
}
