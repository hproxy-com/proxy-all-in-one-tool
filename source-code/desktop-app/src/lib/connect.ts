/* The Connect screen's words and numbers. No React in here, so every rule is
   a plain function with a test. */

import { countryName, type CheckResult } from "./checker";

export type Mode = "fixed" | "list" | "free";

/** The relay's rotation rules for a list, by wire name. */
export type RotationRule = "every_connection" | "every_n" | "random" | "on_failure";

export const ROTATION_RULES: readonly (readonly [RotationRule, string])[] = [
  ["every_connection", "Every connection"],
  ["every_n", "Every N connections"],
  ["random", "Random"],
  ["on_failure", "When one dies"],
];

export const ROTATION_HINT: Record<RotationRule, string> = {
  every_connection: "Each connection goes through the next proxy in the list. A page with fifty requests uses fifty turns.",
  every_n: "Stay on one proxy for N connections, then move to the next.",
  random: "Any proxy that is not resting, picked fresh for every connection.",
  on_failure: "Stay on one proxy until it stops answering, then move to the next. Closest to a single proxy.",
};

/** Free exits by country: the codes the pool is asked for. Empty = anywhere. */
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

/** What to say about a proxy that was just checked, before connecting. */
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
  if (r.protocols?.length) details.push(r.protocols.map((p) => p.toUpperCase()).join(" · "));
  if (r.anonymity) details.push(r.anonymity[0].toUpperCase() + r.anonymity.slice(1));
  const place = placeOf(r);
  if (place) details.push(place);
  if (r.exit_ip && r.exit_ip !== r.ip) details.push(`exit ${r.exit_ip}`);
  if (r.asn_org) details.push(r.asn_org);
  return {
    tone: slow ? "warn" : "ok",
    headline: latency != null ? `Working · ${latency} ms` : "Working",
    details,
    cc: r.country_code?.toLowerCase() ?? undefined,
  };
}

/** The rule of a list in a few words, for a list's line on the screen. */
export function ruleWords(rule: RotationRule, n?: number): string {
  switch (rule) {
    case "every_connection":
      return "a new proxy every connection";
    case "every_n":
      return `a new proxy every ${Math.max(1, n ?? 10)} connections`;
    case "random":
      return "a random proxy each time";
    case "on_failure":
      return "the same proxy until it dies";
  }
}

/* ============================================================
   WHERE TO: the one thing the switch connects to, like the
   location a VPN remembers. One of your saved proxies, one of your
   lists, or the free pool in a country. Kept on this computer, so
   the app opens ready to reconnect with one click.
   ============================================================ */

/** A free place is a country of the pool ("" anywhere) and a protocol. With
    `exit` it is one free proxy picked from the Free tab's list (host:port,
    `exitCountry` its code for the flag); without, the relay picks the first
    that passes its test. */
export type Target =
  | { kind: "fixed"; line: string }
  | { kind: "list"; id: string }
  | { kind: "free"; country: string; socks5: boolean; exit?: string; exitCountry?: string };

export type FreeTarget = Extract<Target, { kind: "free" }>;

const TARGET_KEY = "hproxy-checker-connect-target";

export function loadTarget(): Target | null {
  try {
    const raw = localStorage.getItem(TARGET_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as Target;
    if (t?.kind === "fixed" && typeof t.line === "string" && t.line.trim()) return { kind: "fixed", line: t.line };
    if (t?.kind === "list" && typeof t.id === "string") return { kind: "list", id: t.id };
    if (t?.kind === "free" && typeof t.country === "string") {
      const free: FreeTarget = { kind: "free", country: t.country, socks5: !!t.socks5 };
      if (typeof t.exit === "string" && t.exit.trim()) {
        free.exit = t.exit.trim();
        if (typeof t.exitCountry === "string" && t.exitCountry) free.exitCountry = t.exitCountry;
      }
      return free;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveTarget(t: Target | null): void {
  try {
    if (t) localStorage.setItem(TARGET_KEY, JSON.stringify(t));
    else localStorage.removeItem(TARGET_KEY);
  } catch {
    /* storage may be unavailable; the choice still holds for this session */
  }
}

export function sameTarget(a: Target | null, b: Target | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "fixed" && b.kind === "fixed") return a.line.trim() === b.line.trim();
  if (a.kind === "list" && b.kind === "list") return a.id === b.id;
  if (a.kind === "free" && b.kind === "free") {
    if (a.socks5 !== b.socks5 || (a.exit ?? "") !== (b.exit ?? "")) return false;
    // A picked proxy is the same place under any country's list; the relay's
    // own pick is a country.
    return a.exit ? true : a.country === b.country;
  }
  return false;
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
  return FREE_COUNTRIES.find(([c]) => c === code)?.[1] ?? (code ? code.toUpperCase() : "Anywhere");
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
