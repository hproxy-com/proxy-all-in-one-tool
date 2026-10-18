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
  /** The last day it works, `YYYY-MM-DD` (expiryOf says how that stands). */
  expires?: string;
  note?: string;
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
  /** The last day its lines work, `YYYY-MM-DD`. */
  expires?: string;
  note?: string;
};

/** What a person says about a proxy or a group: a field left out stays as it
    is, an empty one is taken away (a group keeps its name). */
export type Details = { name?: string; expires?: string; note?: string };

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
/** The longest note a place keeps. */
export const MAX_NOTE = 500;

/* An expiry date, as the library keeps it (`clean_date`, `days_left` in
   library.rs): one day of the calendar written YYYY-MM-DD, 2000 to 2199. */
function ymd(day: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2199 || mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d >= 1 && d <= last ? [y, mo, d] : null;
}

/** `day` when it is one day of the calendar written YYYY-MM-DD, else null. */
export function cleanDate(day: string): string | null {
  return ymd(day) ? day.trim() : null;
}

/** Today on this computer's own calendar, YYYY-MM-DD. */
export function todayHere(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Days from `today` to the last day `expires`: 0 on that day, below 0 once past. */
export function daysLeft(expires: string, today: string): number | null {
  const a = ymd(expires);
  const b = ymd(today);
  if (!a || !b) return null;
  return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86_400_000);
}

/** "12 Nov" or "12 Nov 2027" (a year other than this one). */
export function dayWords(day: string, today: string): string {
  const a = ymd(day);
  if (!a) return day;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][a[1] - 1];
  return `${a[2]} ${month}${String(a[0]) === today.slice(0, 4) ? "" : ` ${a[0]}`}`;
}

/** How a place's last day stands: quiet with time left, amber in its last
    three days, red once past (and still usable: the date is what was typed,
    and plans are extended). Null without a date. */
export type Expiry = { days: number; words: string; tone: "quiet" | "warn" | "danger" };
export function expiryOf(expires: string | undefined, today = todayHere()): Expiry | null {
  if (!expires) return null;
  const days = daysLeft(expires, today);
  if (days == null) return null;
  if (days < 0) return { days, words: "Expired", tone: "danger" };
  if (days === 0) return { days, words: "Expires today", tone: "warn" };
  if (days <= 3) return { days, words: days === 1 ? "1 day left" : `${days} days left`, tone: "warn" };
  return { days, words: `${days} days left`, tone: "quiet" };
}

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

/** A place Change offers: one of yours, or the free proxy in use. */
export type ChangePlace = QuickPlace | { kind: "free"; place: FreePlace };

/** The place a row stands for. */
export const placeOfChange = (c: ChangePlace): Place =>
  c.kind === "proxy" ? { kind: "proxy", id: c.proxy.id } : c.kind === "group" ? { kind: "group", id: c.group.id } : c.place;

const answered = (p: ProxyView) => p.last?.ok === true;
const fastestFirst = (a: ProxyView, b: ProxyView) => (a.last?.latencyMs ?? Infinity) - (b.last?.latencyMs ?? Infinity);

/** What Change on Connect offers, at most `max` (2026-10-18: "quick change it or view the full
    list"): the place in use first, whatever its speed, so it is always in sight; then your
    proxies that answered their last check, the fastest first; then what Quick connect would
    show of the rest (used last, then added last), and groups not used yet. A proxy whose last
    check got no answer is never offered (the full list has it). `working`: how many answered. */
export function changePlaces(
  proxies: ProxyView[],
  groups: GroupView[],
  current: Place | null,
  max: number,
): { places: ChangePlace[]; working: number } {
  const first: ChangePlace[] = [];
  if (current?.kind === "proxy") {
    const proxy = proxies.find((p) => p.id === current.id);
    if (proxy) first.push({ kind: "proxy", proxy });
  } else if (current?.kind === "group") {
    const group = groups.find((g) => g.id === current.id);
    if (group) first.push({ kind: "group", group });
  } else if (current?.kind === "free") {
    first.push({ kind: "free", place: current });
  }
  const working = proxies.filter(answered);
  const fast: ChangePlace[] = [...working].sort(fastestFirst).map((proxy) => ({ kind: "proxy", proxy }));
  const unchecked = proxies.filter((p) => !p.last);
  const rest: ChangePlace[] = [
    ...quickPlaces(unchecked, groups, Infinity),
    ...groups
      .filter((g) => g.uses === 0)
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((group) => ({ kind: "group" as const, group })),
  ];
  const places = [...first, ...[...fast, ...rest].filter((c) => !samePlace(placeOfChange(c), current))];
  return { places: places.slice(0, Math.max(0, max)), working: working.length };
}

/** What the switch connects to when nothing is picked: the first place Change would offer, else
    the place used or added last (its connect says what went wrong). Never a free proxy: the
    switch connects yours, and with none of yours it asks you to add them (2026-10-15/16). */
export function firstPlace(proxies: ProxyView[], groups: GroupView[]): Place | null {
  const offered = changePlaces(proxies, groups, null, 1).places[0] ?? quickPlaces(proxies, groups, 1)[0];
  return offered ? placeOfChange(offered) : null;
}

/** Of proxies just saved (their ids in the order given), the one to connect: the first that
    answered its check, else the first. */
export function firstWorking(ids: string[], proxies: ProxyView[]): string | null {
  const saved = ids.map((id) => proxies.find((p) => p.id === id)).filter((p): p is ProxyView => !!p);
  return (saved.find(answered) ?? saved[0])?.id ?? null;
}
