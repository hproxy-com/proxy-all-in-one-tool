/* Saved proxies: the lines a person connected through, so the next time is one
   click. Stored on this computer in the app's own storage, newest first.

   ⚠️ A saved line carries its password, in the clear, in the webview's local
   storage. That is the same place the Chrome extension keeps its proxies and
   the same exposure as a proxy list in a text file on the desktop: anyone who
   can read this user's files can read it. Moving to the OS keychain is on the
   list; until then the screen says "saved on this computer" so nobody assumes
   more. Nothing here is ever sent anywhere. */

import type { RotationRule } from "./connect";

export type SavedVerdict = {
  ok: boolean;
  latencyMs?: number;
  /** Lowercase ISO code, for the flag. */
  cc?: string;
  place?: string;
  exitIp?: string;
  anonymity?: string;
  at: number;
};

export type SavedProxy = {
  id: string;
  line: string;
  addedAt: number;
  lastUsedAt: number;
  uses: number;
  last?: SavedVerdict;
};

const KEY = "hproxy-checker-saved-proxies";
/** Room for a pasted batch (a pasted list becomes one profile per line);
    past this, a list is the tool. */
export const MAX_SAVED = 200;

function idOf(line: string): string {
  // FNV-1a over the trimmed line: stable across sessions, no dependency.
  let h = 2166136261;
  for (let i = 0; i < line.length; i++) {
    h ^= line.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function loadSaved(): SavedProxy[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is SavedProxy => typeof p === "object" && p !== null && typeof (p as SavedProxy).line === "string",
    );
  } catch {
    return [];
  }
}

export function saveSaved(list: SavedProxy[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage may be unavailable; the list still lives in memory */
  }
}

/** Add `line` or bring it to the front, counting the use. Capped at MAX_SAVED,
    dropping the least recently used. */
export function remember(list: SavedProxy[], line: string, now = Date.now()): SavedProxy[] {
  const t = line.trim();
  if (!t) return list;
  const id = idOf(t);
  const existing = list.find((p) => p.id === id);
  const entry: SavedProxy = existing
    ? { ...existing, lastUsedAt: now, uses: existing.uses + 1 }
    : { id, line: t, addedAt: now, lastUsedAt: now, uses: 1 };
  return [entry, ...list.filter((p) => p.id !== id)].slice(0, MAX_SAVED);
}

export function forget(list: SavedProxy[], id: string): SavedProxy[] {
  return list.filter((p) => p.id !== id);
}

/** Attach what the last check or probe found to the saved line, if it is saved. */
export function withVerdict(list: SavedProxy[], line: string, verdict: SavedVerdict): SavedProxy[] {
  const id = idOf(line.trim());
  return list.map((p) => (p.id === id ? { ...p, last: verdict } : p));
}

/** Add `line` to the saved proxies without counting a use: the person pressed
    Add, not Connect. An existing line keeps its place and its count. */
export function addSaved(list: SavedProxy[], line: string, now = Date.now()): SavedProxy[] {
  const t = line.trim();
  if (!t) return list;
  const id = idOf(t);
  if (list.some((p) => p.id === id)) return list;
  return [{ id, line: t, addedAt: now, lastUsedAt: 0, uses: 0 }, ...list].slice(0, MAX_SAVED);
}

/* ============================================================
   SAVED LISTS: a named set of proxies the relay rotates through.

   Saved lists, as in a VPN app. A VPN keeps named collections of
   locations and connects to the
   collection as one thing (Mullvad calls them custom lists); here the
   collection is a list of proxies and the rule decides how the relay
   moves through it. Stored the same way as the saved proxies: on this
   computer only, passwords included, never sent anywhere.
   ============================================================ */

export type SavedList = {
  id: string;
  name: string;
  lines: string[];
  rule: RotationRule;
  /** Connections per proxy, for `every_n`. */
  n?: number;
  addedAt: number;
  lastUsedAt: number;
  uses: number;
};

const LISTS_KEY = "hproxy-checker-saved-lists";
export const MAX_LISTS = 40;
/** A list is stored whole, and the webview's storage holds a few megabytes for
    the whole app, so a list is capped here. The relay itself takes any size. */
export const MAX_LIST_LINES = 20_000;
const RULES: readonly RotationRule[] = ["every_connection", "every_n", "random", "on_failure"];

export function loadLists(): SavedList[] {
  try {
    const raw = localStorage.getItem(LISTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (l): l is SavedList =>
        typeof l === "object" &&
        l !== null &&
        typeof (l as SavedList).id === "string" &&
        typeof (l as SavedList).name === "string" &&
        Array.isArray((l as SavedList).lines) &&
        (l as SavedList).lines.every((x) => typeof x === "string") &&
        RULES.includes((l as SavedList).rule),
    );
  } catch {
    return [];
  }
}

/** False when the storage refused (full, or unavailable): the screen says so,
    rather than letting a list look saved that will be gone after a restart. */
export function saveLists(lists: SavedList[]): boolean {
  try {
    localStorage.setItem(LISTS_KEY, JSON.stringify(lists));
    return true;
  } catch {
    return false;
  }
}

/** A new list, its lines trimmed, blank ones and repeats dropped, capped. */
export function makeList(name: string, lines: string[], rule: RotationRule, n: number | undefined, now = Date.now()): SavedList {
  const clean = [...new Set(lines.map((l) => l.trim()).filter(Boolean))].slice(0, MAX_LIST_LINES);
  return {
    id: `l${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: name.trim() || "My list",
    lines: clean,
    rule,
    n: rule === "every_n" ? Math.max(1, Math.floor(n ?? 10)) : undefined,
    addedAt: now,
    lastUsedAt: 0,
    uses: 0,
  };
}

/** Put `list` in, replacing the one with its id, or first when it is new. */
export function upsertList(lists: SavedList[], list: SavedList): SavedList[] {
  const at = lists.findIndex((l) => l.id === list.id);
  if (at >= 0) return lists.map((l, i) => (i === at ? list : l));
  return [list, ...lists].slice(0, MAX_LISTS);
}

export function forgetList(lists: SavedList[], id: string): SavedList[] {
  return lists.filter((l) => l.id !== id);
}

/** Count a connection through `id` and bring it to the front. */
export function listUsed(lists: SavedList[], id: string, now = Date.now()): SavedList[] {
  const l = lists.find((x) => x.id === id);
  if (!l) return lists;
  return [{ ...l, uses: l.uses + 1, lastUsedAt: now }, ...lists.filter((x) => x.id !== id)];
}

/** `base`, or `base 2`, `base 3` … when a list already has that name. */
export function freeListName(lists: SavedList[], base: string): string {
  const taken = new Set(lists.map((l) => l.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Add every line as its own saved proxy, in the order pasted (the first line
    ends up on top). Lines already saved stay where they are. */
export function addManySaved(list: SavedProxy[], lines: string[], now = Date.now()): SavedProxy[] {
  // A repeat keeps its first place in the paste, so the repeats go first.
  const uniq = [...new Set(lines.map((l) => l.trim()).filter(Boolean))];
  let out = list;
  for (let i = uniq.length - 1; i >= 0; i--) out = addSaved(out, uniq[i], now);
  return out;
}
