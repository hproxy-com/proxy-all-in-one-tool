/* The Connect screen's words and numbers. No React in here, so every rule is
   a plain function with a test. */

import { countryName, type CheckResult } from "./checker";
import type { GroupView, ProxyView, Rule } from "./places";
import type { Targeting } from "./tauri";

/** The rule a new group starts with. A site sees one address for the whole
    visit, which is what residential sessions are for; Next IP moves on. */
export const DEFAULT_ROTATION: Rule = "on_failure";

/** In the order the group editor offers them, the usual answer first. */
export const ROTATION_RULES: readonly (readonly [Rule, string])[] = [
  ["on_failure", "When one dies"],
  ["every_minutes", "Every N minutes"],
  ["every_connection", "Every connection"],
  ["every_n", "Every N connections"],
  ["random", "Random"],
];

export const ROTATION_HINT: Record<Rule, string> = {
  on_failure: "Stays on one proxy until it stops answering, then moves to the next. Next IP moves on whenever you like.",
  every_minutes: "Stays on one proxy for N minutes, then moves to the next. Next IP moves on at once.",
  every_connection: "Each connection goes through the next proxy in the group. A page with fifty requests uses fifty turns.",
  every_n: "Stays on one proxy for N connections, then moves to the next.",
  random: "Any proxy that answers, picked fresh for every connection.",
};

/** Whether a rule takes a number: connections for `every_n`, minutes for `every_minutes`. */
export const takesN = (rule: Rule): boolean => rule === "every_n" || rule === "every_minutes";

/** The countries the Free tab offers before the pool's own list is in, or when
    it cannot be loaded (lib/freeList.ts, countryChoices). The pool usually has
    many more. Empty = anywhere. */
export const FREE_COUNTRIES: readonly (readonly [string, string])[] = [
  ["", "Anywhere"],
  ["US", "United States"],
  ["GB", "United Kingdom"],
  ["DE", "Germany"],
  ["FR", "France"],
  ["NL", "Netherlands"],
  ["CA", "Canada"],
  ["JP", "Japan"],
  ["SG", "Singapore"],
  ["BR", "Brazil"],
  ["IN", "India"],
  ["AU", "Australia"],
];

/** Non-empty lines of a pasted list. */
export function listLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** The line with its password hidden, in every shape a provider prints:
    `user:pass@host:port`, `scheme://user:pass@host:port`, `host:port:user:pass`.
    A line with no login comes back unchanged. */
export function maskLine(line: string): string {
  const t = line.trim();
  const schemeEnd = t.indexOf("://");
  const start = schemeEnd >= 0 ? schemeEnd + 3 : 0;
  const body = t.slice(start);
  // host:port:user:pass first: the port is digits, so a `@` in the password
  // cannot be mistaken for the login separator.
  const colon = body.match(/^([^:/@\s]+|\[[^\]]+\]):(\d{1,5}):([^:]+):(.+)$/);
  if (colon) {
    return `${t.slice(0, start)}${colon[1]}:${colon[2]}:${colon[3]}:••••`;
  }
  // user:pass@host:port: the last `@` separates the login from the address,
  // so a password may contain `@` too.
  const at = body.lastIndexOf("@");
  if (at > 0) {
    const creds = body.slice(0, at);
    const sep = creds.indexOf(":");
    if (sep >= 0) {
      return `${t.slice(0, start)}${creds.slice(0, sep)}:••••${body.slice(at)}`;
    }
  }
  return t;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  if (u === 0) return `${Math.round(v)} B`;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** A transfer speed the way the connected card shows it: "0 B/s", "820 B/s",
    "12 KB/s", "1.2 MB/s" (same units as formatBytes). */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** One reading of the relay's byte counters, and when it was taken. */
export type ByteReading = { at: number; up: number; down: number };

/** The speed between two readings, in bytes a second. Null when there is no
    earlier reading, no time between them, or the counters went backwards (a
    new relay started counting from zero). */
export function rateBetween(prev: ByteReading | null, next: ByteReading): { up: number; down: number } | null {
  if (!prev) return null;
  const seconds = (next.at - prev.at) / 1000;
  if (seconds <= 0) return null;
  const up = next.up - prev.up;
  const down = next.down - prev.down;
  if (up < 0 || down < 0) return null;
  return { up: up / seconds, down: down / seconds };
}

/** `0:07`, `12:34`, `1:02:03`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** `just now`, `12 s ago`, `3 min ago`, `2 h ago`, `4 d ago`. */
export function formatAgo(ms: number): string {
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

export type Verdict = {
  tone: "ok" | "warn" | "danger";
  headline: string;
  /** Short facts to show as quiet tags after the headline. */
  details: string[];
  cc?: string;
};

/** City and country as one phrase, from whatever is known. */
export function placeOf(r: { city?: string | null; country?: string | null; country_code?: string | null }): string | undefined {
  const country = r.country ?? countryName(r.country_code ?? undefined);
  if (r.city && country) return `${r.city}, ${country}`;
  return r.city ?? country ?? undefined;
}

const TONE_OF: Record<"good" | "warn" | "bad", Verdict["tone"]> = { good: "ok", warn: "warn", bad: "danger" };

/** What to say about a proxy that was just checked, before connecting. The
    headline is the engine's verdict on whether a connection through it carries
    traffic (a proxy that only fetches plain http:// pages answers, and still
    opens no https site), so the window never calls such a proxy working. */
export function verdictOf(r: CheckResult): Verdict {
  if (!r.alive) {
    return {
      tone: "danger",
      headline: "Not answering",
      details: [r.error ?? "the proxy did not answer"].filter(Boolean),
    };
  }
  const latency = r.latency_ms ?? undefined;
  const slow = latency != null && latency > 1500;
  const details: string[] = [];
  const u = r.usable;
  if (u?.why && u.tone !== "good") details.push(u.why);
  if (r.protocols?.length) details.push(r.protocols.map((p) => p.toUpperCase()).join(" · "));
  if (r.anonymity) details.push(r.anonymity[0].toUpperCase() + r.anonymity.slice(1));
  const place = placeOf(r);
  if (place) details.push(place);
  if (r.exit_ip && r.exit_ip !== r.ip) details.push(`exit ${r.exit_ip}`);
  if (r.asn_org) details.push(r.asn_org);
  const cc = r.country_code?.toLowerCase() ?? undefined;
  if (u) return { tone: TONE_OF[u.tone], headline: u.says, details, cc };
  // A row the engine did not read (checked through the API): only what answered.
  return {
    tone: slow ? "warn" : "ok",
    headline: latency != null ? `Working · ${latency} ms` : "Working",
    details,
    cc,
  };
}

/** The rule of a group in a few words, for its line on the screen. */
export function ruleWords(rule: Rule, n?: number): string {
  switch (rule) {
    case "every_connection":
      return "a new proxy every connection";
    case "every_n":
      return `a new proxy every ${Math.max(1, n ?? 10)} connections`;
    case "every_minutes": {
      const minutes = Math.max(1, n ?? 10);
      return minutes === 1 ? "a new proxy every minute" : `a new proxy every ${minutes} minutes`;
    }
    case "random":
      return "a random proxy each time";
    case "on_failure":
      return "the same proxy until it dies";
  }
}

/** The host:port of the upstream the relay says is in use, as it prints one
    (`http://203.0.113.5:8080 (no login)`, `socks5://user:********@[2001:db8::1]:1080`);
    null while it says something else, such as that it is switching. */
export function addressInUse(inUse: string): string | null {
  const first = inUse.trim().replace(/^[a-z0-9]+:\/\//i, "").split(/\s/)[0];
  const addr = first.slice(first.lastIndexOf("@") + 1);
  return /^(\[[^\]\s]+\]|[^\s:@[\]]+):\d{1,5}$/.test(addr) ? addr : null;
}

/** The name of a free-pool country, or "Anywhere". */
export function freeCountryName(code: string): string {
  return code ? (countryName(code) ?? code.toUpperCase()) : "Anywhere";
}

/** What a proxy is called on screen: the name it was given; else the session
    its login holds ("Session 7f3a9c21"), because a hundred sessions on one
    gateway share an address; else its address. Never the password. The same
    rule as the tray's (src-tauri/src/places.rs, `proxy_title`). */
export function proxyTitle(p: { address: string; name?: string; about?: Targeting | null }): string {
  return p.name?.trim() || (p.about?.session ? `Session ${p.about.session}` : "") || p.address;
}

/** A provider's spelling of a place, for reading: "new york", "new-york" and
    "NEW_YORK" all read "New York". */
export function placeName(raw: string): string {
  return raw
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

/** The most precise place a login targets: its city, else its region, else
    its country. Empty when it names none. */
export function targetedPlace(t: Targeting | null | undefined): string {
  if (!t) return "";
  return t.city ? placeName(t.city) : t.region ? placeName(t.region) : t.country ? (countryName(t.country) ?? t.country) : "";
}

/** What a line targets, in a few words: the most precise place it names and
    how it moves ("California · 30 min", "Los Angeles · sticky", "Rotating ·
    Germany"). Empty when it targets nothing worth saying. */
export function aboutWords(t: Targeting | null | undefined): string {
  if (!t) return "";
  const place = targetedPlace(t);
  const moves = t.session ? (t.minutes ? `${t.minutes} min` : "sticky") : "Rotating";
  return t.session ? [place, moves].filter(Boolean).join(" · ") : [moves, place].filter(Boolean).join(" · ");
}

/** A number with spaces between the thousands: "1 000", "12 500". */
export const spacedN = (n: number): string => n.toLocaleString("en-US").replace(/,/g, " ");

/** A group in a few words: how many it holds (sessions when every member
    holds one), where they all are when they agree, and its rule. "100
    sessions in California · the same proxy until it dies". */
export function groupWords(g: Pick<GroupView, "size" | "rule" | "n" | "summary">): string {
  const what = g.size === 1 ? "proxy" : g.summary.sessions === g.size ? "sessions" : "proxies";
  const where = targetedPlace(g.summary.shared);
  return `${spacedN(g.size)} ${what}${where ? ` in ${where}` : ""} · ${ruleWords(g.rule, g.n)}`;
}

/** How quick a proxy answered, as three bars, the same on every list (My
    proxies, the free proxies, Recent). The whole test through it (to the proxy,
    through it to a site over HTTPS, and back) under 0.8 seconds is fast, under
    2 seconds fine, anything slower slow. VPN apps grade a bare ping (three bars
    under 200 ms); a test through a proxy takes several round trips,
    so the steps here are wider. */
export function speedOf(ms: number | null | undefined): { bars: 1 | 2 | 3; word: "Fast" | "Fine" | "Slow" } {
  if (ms == null) return { bars: 1, word: "Slow" };
  if (ms < 800) return { bars: 3, word: "Fast" };
  if (ms < 2000) return { bars: 2, word: "Fine" };
  return { bars: 1, word: "Slow" };
}

/** How My proxies can be ordered. */
export type SavedSort = "recent" | "fastest" | "name" | "expiring";

export const SAVED_SORTS: readonly (readonly [SavedSort, string])[] = [
  ["recent", "Recently used"],
  ["fastest", "Fastest first"],
  ["name", "By name"],
  ["expiring", "Expires soonest"],
];

export const isSavedSort = (v: unknown): v is SavedSort => v === "recent" || v === "fastest" || v === "name" || v === "expiring";

/** Where a saved proxy stands for "Fastest first": working with a time, then
    working without one, then never checked, then not answering. */
const speedRank = (p: ProxyView): number => (!p.last ? 2 : !p.last.ok ? 3 : p.last.latencyMs != null ? 0 : 1);

/** The saved proxies in the order asked for. "recent" is the order they are
    kept in (the one used or added last on top); "fastest" puts the working ones
    first, the quickest on top; "name" goes by what each is called, numbers in
    number order ("Proxy 2" before "Proxy 10"); "expiring" puts the ones with a
    last day first, the soonest on top (the expired ones above all), then the
    ones without. Ties keep the kept order. */
export function sortSaved(list: ProxyView[], sort: SavedSort): ProxyView[] {
  if (sort === "recent") return list;
  const kept = new Map(list.map((p, i) => [p.id, i]));
  const byKept = (a: ProxyView, b: ProxyView) => (kept.get(a.id) ?? 0) - (kept.get(b.id) ?? 0);
  if (sort === "expiring") {
    // YYYY-MM-DD orders as text the way it orders as days.
    return [...list].sort((a, b) => (a.expires ?? "9999").localeCompare(b.expires ?? "9999") || byKept(a, b));
  }
  if (sort === "fastest") {
    return [...list].sort(
      (a, b) =>
        speedRank(a) - speedRank(b) ||
        (a.last?.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.last?.latencyMs ?? Number.MAX_SAFE_INTEGER) ||
        byKept(a, b),
    );
  }
  return [...list].sort((a, b) => proxyTitle(a).localeCompare(proxyTitle(b), "en", { numeric: true, sensitivity: "base" }) || byKept(a, b));
}

/** The saved proxies whose name, note, address, place or session holds what
    was typed. The window never holds a password, so none can be found by typing it. */
export function matchSaved(list: ProxyView[], typed: string): ProxyView[] {
  const q = typed.trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) =>
    [
      p.name,
      p.note,
      p.address,
      p.last?.place,
      p.about?.session,
      p.about?.city && placeName(p.about.city),
      p.about?.region && placeName(p.about.region),
      p.about?.country && countryName(p.about.country),
    ].some((field) => field?.toLowerCase().includes(q)),
  );
}

/** The address of a line and its login name, for a row's title. The password
    never comes out: `user:pass@host:port`, `scheme://user:pass@host:port` and
    `host:port:user:pass` all give `host:port` and `user`. */
export function lineParts(line: string): { address: string; user?: string; scheme?: string } {
  const t = line.trim();
  const schemeEnd = t.indexOf("://");
  const scheme = schemeEnd >= 0 ? t.slice(0, schemeEnd).toLowerCase() : undefined;
  const body = schemeEnd >= 0 ? t.slice(schemeEnd + 3) : t;
  // host:port:user:pass first: the port is digits, so a `@` in the password
  // cannot be mistaken for the login separator (the same rule as maskLine).
  const colon = body.match(/^([^:/@\s]+|\[[^\]]+\]):(\d{1,5}):([^:]+):(.+)$/);
  if (colon) return { address: `${colon[1]}:${colon[2]}`, user: colon[3], scheme };
  const at = body.lastIndexOf("@");
  if (at > 0) {
    const creds = body.slice(0, at);
    const sep = creds.indexOf(":");
    return { address: body.slice(at + 1), user: sep >= 0 ? creds.slice(0, sep) : creds, scheme };
  }
  return { address: body, scheme };
}
