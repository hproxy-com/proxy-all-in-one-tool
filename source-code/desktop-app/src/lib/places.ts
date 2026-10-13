/* The places a person connects through, as the window sees them: the view the
   library hands over (proxy-engine/hproxy-places, kept by
   src-tauri/src/places.rs). Never a password: a place is named by its id, and
   the line it stands for stays on the Rust side, which dials it. The shapes
   mirror the Rust ones field for field. */

import type { Targeting } from "./tauri";

/** What the last check or probe of a saved proxy found. */
export type Verdict = {
  /** A connection through it carries tunnels (https sites, apps). */
  ok: boolean;
  latencyMs?: number;
  /** Lowercase country code of the exit, for the flag. */
  cc?: string;
  place?: string;
  exitIp?: string;
  anonymity?: string;
  /** The engine's words for the row: "Working · 180 ms", "Can't open https sites".
      Absent for a live probe and for checks saved before the words existed. */
  says?: string;
  tone?: "good" | "warn" | "bad";
  way?: "http" | "socks5";
  /** Unix milliseconds. */
  at: number;
};

/** The few words a saved proxy's row says about its last check, or nothing
    when that check found it working (the row shows its place instead). */
export function lastCheckWords(last: Verdict | undefined): { text: string; tone: "warn" | "danger" } | null {
  if (!last) return null;
  if (!last.ok) return { text: last.says ?? "Not answering", tone: "danger" };
  if (last.tone === "bad" && last.says) return { text: last.says, tone: "danger" };
  if (last.tone === "warn" && last.says) return { text: last.says, tone: "warn" };
  return null;
}

/** One saved proxy: its address, login name and what it targets, never its password. */
export type ProxyView = {
  id: string;
  name?: string;
  /** `host:port`, IPv6 in brackets. */
  address: string;
  user?: string;
  scheme?: string;
  /** What the login targets (a session, a region), when anything. */
  about?: Targeting;
  addedAt: number;
  lastUsedAt: number;
  uses: number;
  last?: Verdict;
};

/** How a group moves through its members. */
export type Rule = "on_failure" | "every_minutes" | "every_connection" | "every_n" | "random";

/** What every member of a group targets alike, and how many hold a session. */
export type GroupSummary = { shared: Targeting; sessions: number };

/** A group: its size and what its members target, never a line. */
export type GroupView = {
  id: string;
  name: string;
  size: number;
  rule: Rule;
  /** Minutes for `every_minutes`, connections for `every_n`. */
  n?: number;
  addedAt: number;
  lastUsedAt: number;
  uses: number;
  summary: GroupSummary;
};

/** One member of a group, by its place in it (from 0). */
export type MemberView = { index: number; address: string; user?: string; about?: Targeting };

/** What the switch connects to. */
export type Place =
  | { kind: "proxy"; id: string }
  | { kind: "group"; id: string }
  | { kind: "free"; country: string; socks5: boolean; exit?: string; exitCountry?: string };

export type FreePlace = Extract<Place, { kind: "free" }>;

/** Everything the person keeps. */
export type LibraryView = { proxies: ProxyView[]; groups: GroupView[]; picked?: Place | null };

/** What the window gets at start. */
export type PlacesStart = { view: LibraryView; movedFromWindow: boolean; notice?: string };

/** A group to save: a new one has no id. */
export type GroupInput = { id?: string; name: string; lines: string[]; rule: Rule; n?: number };

export const EMPTY_LIBRARY: LibraryView = { proxies: [], groups: [], picked: null };

/* The library's ceilings (proxy-engine/hproxy-places/src/library.rs): the
   window says them before the library would leave something out. */
/** The longest name a place keeps (the library cuts longer ones). */
export const MAX_NAME = 60;
/** How many proxies are saved; a bigger batch is a group. */
export const MAX_PROXIES = 10_000;
/** How many lines a group holds. */
export const MAX_GROUP_LINES = 100_000;

/** Which Proxies tab lists a place. */
export const tabOf = (p: Place | null | undefined): "proxies" | "groups" | "free" =>
  p?.kind === "group" ? "groups" : p?.kind === "free" ? "free" : "proxies";

/** Whether two places are the same place. A free proxy picked from a list is
    the same place under any country; the pool's own pick is its country. */
export function samePlace(a: Place | null | undefined, b: Place | null | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "proxy" && b.kind === "proxy") return a.id === b.id;
  if (a.kind === "group" && b.kind === "group") return a.id === b.id;
  if (a.kind === "free" && b.kind === "free") {
    if (a.socks5 !== b.socks5 || (a.exit ?? "") !== (b.exit ?? "")) return false;
    return a.exit ? true : a.country === b.country;
  }
  return false;
}

/** `base`, or `base 2`, `base 3` … when a group already has that name. */
export function freeGroupName(groups: GroupView[], base: string): string {
  const taken = new Set(groups.map((g) => g.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** A place Quick connect offers: one of your proxies or one of your groups. */
export type QuickPlace = { kind: "proxy"; proxy: ProxyView } | { kind: "group"; group: GroupView };

/** What Quick connect shows, at most `max`: the places used last, newest first,
    then proxies saved but not used yet, the newest added first, so a proxy
    pasted a moment ago is one click away. The tray lists the same
    (src-tauri/src/places.rs, `quick`). */
export function quickPlaces(proxies: ProxyView[], groups: GroupView[], max: number): QuickPlace[] {
  const used: { at: number; place: QuickPlace }[] = [
    ...proxies.filter((p) => p.uses > 0).map((proxy) => ({ at: proxy.lastUsedAt, place: { kind: "proxy" as const, proxy } })),
    ...groups.filter((g) => g.uses > 0).map((group) => ({ at: group.lastUsedAt, place: { kind: "group" as const, group } })),
  ];
  used.sort((a, b) => b.at - a.at);
  const fresh: QuickPlace[] = proxies
    .filter((p) => p.uses === 0)
    .sort((a, b) => b.addedAt - a.addedAt)
    .map((proxy) => ({ kind: "proxy" as const, proxy }));
  return [...used.map((u) => u.place), ...fresh].slice(0, Math.max(0, max));
}
