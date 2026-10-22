/* Usage counts (src-tauri/src/usage.rs): asked once, a switch in Settings with the last report
   shown exactly as it went, and nothing counted or sent before a yes. The counting happens on
   the Rust side, where the connections, checks and saves happen; the window only reports what
   it alone sees: a search, and a crash of the window itself. What a report holds: PRIVACY.md,
   "Usage counts". */

import { isTauri } from "./tauri";

export type UsageAnswer = "unasked" | "yes" | "no";

export type UsageView = {
  answer: UsageAnswer;
  /** The last report exactly as it was sent, or null before the first one. */
  last: Record<string, unknown> | null;
};

/** The features only the window sees, by their fixed names (hproxy-api, `usage::FEATURES`). */
export type WindowFeature = "search";

/* The browser preview keeps an answer in memory: a yes with a sample report, so Settings shows
   what a report looks like; `?usage=ask` shows the question instead. */
const SAMPLE_REPORT: Record<string, unknown> = {
  copy: "5f0c2a9e7b6d4c3e8a1f9b2d7c6e5a40",
  app: "desktop",
  os: "windows",
  version: "0.4.3",
  day: "2026-10-18",
  opened: 3,
  connects: { ok: 4, failed: { timeout: 1 } },
  checks: { runs: 2, proxies: "101-1000" },
  saved: "11-100",
  groups: 2,
  free: 0,
  features: ["checker", "fraud_score", "groups"],
  crashes: {},
};

let preview: UsageView | null = null;

function previewView(): UsageView {
  if (!preview) {
    const ask = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("usage") === "ask";
    preview = ask ? { answer: "unasked", last: null } : { answer: "yes", last: SAMPLE_REPORT };
  }
  return preview;
}

export async function usageGet(): Promise<UsageView> {
  if (!isTauri()) return previewView();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<UsageView>("usage_get");
}

/** Yes or no. No deletes this copy's number and every count; a later yes makes a new number. */
export async function usageAnswer(yes: boolean): Promise<UsageView> {
  if (!isTauri()) {
    preview = yes ? { answer: "yes", last: previewView().last ?? SAMPLE_REPORT } : { answer: "no", last: null };
    return preview;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<UsageView>("usage_answer", { yes });
}

/* A feature counts once a day at most on the Rust side; once per window is enough here, so a
   search typed letter by letter is one call. */
const said = new Set<string>();

async function count(event: Record<string, string>): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("usage_count", { event });
}

export function countFeature(name: WindowFeature): void {
  if (said.has(name)) return;
  said.add(name);
  void count({ kind: "feature", name }).catch(() => said.delete(name));
}

/** The window crashed (ErrorBoundary): only the count, never the error. */
export function countWindowCrash(): void {
  void count({ kind: "crash", part: "window" }).catch(() => {});
}

/** The lines that say what a report holds, for the question and for Settings. */
export const USAGE_HOLDS: readonly string[] = [
  "How often HProxy was opened",
  "How many connections worked, and why the others failed",
  "How many checks ran, and how long the lists were, roughly",
  "How many proxies and groups you keep, roughly",
  "Which features you used",
  "How often a part of the app crashed",
];

export const USAGE_NEVER = "Never a proxy, a login, a site you visit, a name, a note or anything else you type.";
