/* The leak check on the Connect panel: what a site can still learn about you
   through a connected proxy, one row for each way, with what to do about it.
   No React in here, so each row is a plain function with a test.

   The rule is the Chrome extension's (chrome-extension/analyzer.js): a check
   that cannot answer says so, and never reports a pass it did not measure.

     DNS        which resolver the proxy looks names up with, and where it is
                (the DNS leak test, hproxy.com/api/leak)
     WebRTC     browsers can open calls that go around any proxy
     Time zone  the computer's clock against the exit's place, and on Windows
                the match (src-tauri/src/timezone.rs)
     Language   the languages a browser asks pages in, against the exit's country */

import { countryName } from "./checker";
import type { DnsLeak, LeakResolver, ZoneStatus } from "./tauri";

export type LeakTone = "ok" | "warn" | "mute";

/** What a row's button does (ConnectionCard.tsx, LeakCheck). */
export type LeakAction = "extension" | "match_zone" | "match_zone_again" | "date_time_settings";

export type LeakRow = {
  id: "dns" | "webrtc" | "timezone" | "language";
  label: string;
  tone: LeakTone;
  /** One short line. */
  headline: string;
  /** What it means, for the second line. */
  detail?: string;
  /** Buttons under the line, in order. */
  actions?: { id: LeakAction; label: string }[];
};

/** Where the Chrome extension is offered: it blocks WebRTC while connected. */
export const EXTENSION_PAGE = "https://hproxy.com/extension";

/** Windows' Date and time settings, where "Set time zone automatically" is
    (allowed for the opener in src-tauri/capabilities/desktop.json). */
export const DATE_TIME_SETTINGS = "ms-settings:dateandtime";

/** How long browsers get to notice a zone we set before the row says it did
    not hold. Chrome took a few seconds on Windows 11 (2026-09-28). */
export const ZONE_SETTLE_MS = 10_000;

const nameOf = (cc?: string | null) => (cc ? (countryName(cc) ?? cc.toUpperCase()) : undefined);

/** Countries said with "the": the Netherlands, the United States. */
const WITH_THE = /^(United |Czech Republic$|Dominican Republic$|Central African Republic$|Netherlands$|Philippines$|Bahamas$|Maldives$|Gambia$|Comoros$|Seychelles$)/;

/** " in Germany", " in the Netherlands", or nothing for an unknown country. */
function inCountry(cc?: string | null): string {
  const n = nameOf(cc);
  return n ? ` in ${WITH_THE.test(n) ? "the " : ""}${n}` : "";
}

/** The networks that answered, once each: "Google LLC", "Google LLC and Quad9". */
function resolverNames(resolvers: LeakResolver[]): string {
  const names = [...new Set(resolvers.map((r) => r.asn_org?.trim() || r.ip))];
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** DNS. `leak` null: still checking. */
export function dnsRow(leak: DnsLeak | null, exitCc?: string | null): LeakRow {
  const base = { id: "dns" as const, label: "DNS" };
  const byName = "Browsers hand the proxy each site's name, so your own provider does not see where you go.";
  if (!leak) return { ...base, tone: "mute", headline: "Checking which resolver the proxy uses…" };
  if (leak.state === "unavailable") {
    return { ...base, tone: "ok", headline: "Site names go to the proxy", detail: `${byName} Which resolver it uses could not be measured: ${leak.why}.` };
  }
  if (leak.state === "not_seen" || leak.resolvers.length === 0) {
    return { ...base, tone: "ok", headline: "Site names go to the proxy", detail: `${byName} The proxy did not look up our test name, so its resolver is unknown.` };
  }
  const names = resolverNames(leak.resolvers);
  const countries = [...new Set(leak.resolvers.map((r) => r.country_code?.toUpperCase()).filter((c): c is string => !!c))];
  const exit = exitCc?.toUpperCase();
  if (!exit || countries.length === 0) {
    return { ...base, tone: "ok", headline: `Looked up by ${names}`, detail: byName };
  }
  if (countries.every((c) => c === exit)) {
    return { ...base, tone: "ok", headline: `Looked up by ${names}${inCountry(exit)}, like your exit`, detail: byName };
  }
  const elsewhere = countries.find((c) => c !== exit);
  return {
    ...base,
    tone: "warn",
    headline: `Looked up by ${names}${inCountry(elsewhere)}; your exit is${inCountry(exit)}`,
    detail: "Sites can see which resolver asked for them and compare its country with your address.",
  };
}

/** WebRTC. A proxy cannot carry it; on a computer the extension can stop it. */
export function webrtcRow(phone: boolean): LeakRow {
  return {
    id: "webrtc",
    label: "WebRTC",
    tone: "warn",
    headline: "Browsers can show your real address",
    detail: phone
      ? "WebRTC calls go around any proxy, and a phone's browser cannot switch them off."
      : "WebRTC calls go around any proxy. In Chrome, the HProxy extension blocks them while you are connected.",
    actions: phone ? undefined : [{ id: "extension", label: "Get the extension" }],
  };
}

/** This computer's (or phone's) time zone, as sites read it. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Minutes east of UTC that `zone` shows at `at`, or null for an unknown zone. */
export function offsetMinutes(zone: string, at: Date): number | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    if (part === "GMT") return 0;
    const m = part?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!m) return null;
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return null;
  }
}

/** The time zone match, as the row needs it. */
export type ZoneMatchView = Pick<ZoneStatus, "supported" | "matching" | "matched" | "matched_at_ms" | "automatic" | "problem">;

/** Time zone: the computer's clock against the exit's. The same time counts
    as a match (Paris and Berlin), whatever the zone is called. With `zone`,
    the match (Settings, "Match my time zone to the exit") is offered, shown
    while it is made, and named when it did not hold. `at` is now. */
export function timezoneRow(local: string, exit?: string | null, at: Date = new Date(), zone?: ZoneMatchView | null): LeakRow {
  const base = { id: "timezone" as const, label: "Time zone" };
  if (!exit) return { ...base, tone: "mute", headline: local, detail: "The exit's time zone is not known, so there is nothing to compare." };
  const a = offsetMinutes(local, at);
  if (local === exit || (a !== null && a === offsetMinutes(exit, at))) {
    if (zone?.matched) return { ...base, tone: "ok", headline: `${local}, set to your exit's until you disconnect` };
    if (local === exit) return { ...base, tone: "ok", headline: `${local}, like your exit` };
    return { ...base, tone: "ok", headline: `${local}, the same time as your exit (${exit})` };
  }
  const warn = { ...base, tone: "warn" as const, headline: `Your clock: ${local} · your exit: ${exit}` };
  const why = "Sites can read your computer's time zone and compare it with your address.";
  if (!zone?.supported) return { ...warn, detail: why };
  if (zone.problem) {
    return { ...warn, detail: `The time zone could not be matched: ${zone.problem}.`, actions: [{ id: "match_zone_again", label: "Try again" }] };
  }
  if (!zone.matching) {
    return {
      ...warn,
      detail: `${why} HProxy can set it to your exit's while you are connected, and put yours back after.`,
      actions: [{ id: "match_zone", label: "Match it while connected" }],
    };
  }
  // On, and not matched yet, or matched a moment ago: browsers take a few
  // seconds to read a new zone.
  if (!zone.matched || (zone.matched_at_ms != null && at.getTime() - zone.matched_at_ms < ZONE_SETTLE_MS)) {
    return { ...base, tone: "mute", headline: "Setting your time zone to your exit's…" };
  }
  return {
    ...warn,
    detail: zone.automatic
      ? 'Windows put its own time zone back: "Set time zone automatically" is on in its Date and time settings. Turn it off for the match to hold.'
      : "The time zone was changed again after it was matched.",
    actions: [
      { id: "match_zone_again", label: "Match again" },
      ...(zone.automatic ? [{ id: "date_time_settings" as const, label: "Date and time settings" }] : []),
    ],
  };
}

/** The country a language tag names: "de-DE" is DE, "en" names none. */
export function localeCountry(tag: string): string | null {
  const m = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(tag);
  return m ? m[1].toUpperCase() : null;
}

/** Language: the language pages are asked in first, against the exit's
    country. The first one is what sites compare (`navigator.language`, the
    head of Accept-Language): a German browser that also takes English does
    not look American. */
export function languageRow(languages: readonly string[], exitCc?: string | null): LeakRow {
  const base = { id: "language" as const, label: "Language" };
  const shown = languages.slice(0, 3).join(", ") || "none";
  const first = languages[0];
  const claimed = first ? localeCountry(first) : null;
  const exit = exitCc?.toUpperCase();
  if (!exit || !claimed) {
    return { ...base, tone: "mute", headline: shown, detail: "Your first language names no country, so there is nothing to contradict." };
  }
  if (claimed === exit) return { ...base, tone: "ok", headline: `${shown}, like your exit` };
  return {
    ...base,
    tone: "warn",
    headline: `${shown} · your exit is${inCountry(exit)}`,
    detail: `Browsers ask sites for ${first} pages first, and sites can compare that with your address. Putting your exit's language first in your browser's language settings hides it.`,
  };
}
