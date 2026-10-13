/* BROWSER PREVIEW ONLY. A pretend relay, so the Connect screen can be looked
   at (and screenshotted) in every state without the desktop app. Loaded only
   when the window is not Tauri; `?demo=connect` opens already connected.
   Nothing in here may be imported by production code paths. */

import { countryName, type CheckResult } from "./checker";
import { FREE_COUNTRIES } from "./connect";
import type { Place } from "./places";
import { hashSeed, mulberry32 } from "./preview";
import { demoPlaceForRelay, demoSampleGroup } from "./previewPlaces";
import { DEFAULT_PROBE_URL } from "./settings";
import {
  isMobile,
  type DnsLeak,
  type ConnectStatus,
  type FreeCountry,
  type FreeExit,
  type FreeTest,
  type RelayHealth,
  type SourceInfo,
  type SystemProxySupport,
  type ZoneStatus,
} from "./tauri";

/* tz: the place's time zone; dns: the country of the resolver the pretend DNS
   leak test reports for it (the Netherlands one looks names up in Germany, so
   the preview shows the warning too). */
type Exit = { ip: string; cc: string; country: string; city: string; asn_org: string; ms: number; tz: string; dns?: string };

/** Where the pretend cities are, for the map's dot (latitude, longitude). */
const CITY_AT: Record<string, readonly [number, number]> = {
  Ashburn: [39.04, -77.49],
  Dallas: [32.78, -96.8],
  "Los Angeles": [34.05, -118.24],
  "New York": [40.71, -74.01],
  London: [51.51, -0.13],
  Manchester: [53.48, -2.24],
  Frankfurt: [50.11, 8.68],
  Berlin: [52.52, 13.4],
  Nuremberg: [49.45, 11.08],
  Paris: [48.86, 2.35],
  Roubaix: [50.69, 3.18],
  Amsterdam: [52.37, 4.9],
  Rotterdam: [51.92, 4.48],
  Toronto: [43.65, -79.38],
  Montreal: [45.5, -73.57],
  Tokyo: [35.68, 139.69],
  Osaka: [34.69, 135.5],
  Singapore: [1.35, 103.82],
  "São Paulo": [-23.55, -46.63],
  "Rio de Janeiro": [-22.91, -43.17],
  Mumbai: [19.08, 72.88],
  Bangalore: [12.97, 77.59],
  Sydney: [-33.87, 151.21],
  Melbourne: [-37.81, 144.96],
};

// The first exit is the one ?demo=connect lands on, so the store screenshots
// show it: an address whose pretend fraud score is low (lib/fraud.ts).
const EXITS: Exit[] = [
  { ip: "203.0.113.24", cc: "DE", country: "Germany", city: "Frankfurt", asn_org: "Hetzner Online", ms: 143, tz: "Europe/Berlin" },
  { ip: "198.51.100.24", cc: "NL", country: "Netherlands", city: "Amsterdam", asn_org: "DigitalOcean", ms: 97, tz: "Europe/Amsterdam", dns: "DE" },
  { ip: "192.0.2.77", cc: "US", country: "United States", city: "Ashburn", asn_org: "Amazon AWS", ms: 188, tz: "America/New_York" },
  { ip: "203.0.113.130", cc: "GB", country: "United Kingdom", city: "London", asn_org: "Akamai Linode", ms: 121, tz: "Europe/London" },
];

type Demo = {
  startedAt: number;
  place: Place;
  source: SourceInfo;
  systemProxy: boolean;
  exit: number;
  /** A free proxy picked from the Free tab's list, until the first rotation. */
  picked: Exit | null;
  /** The free country asked for: "New IP" stays in it, like the real pool. */
  freeCountry: string | null;
  health: RelayHealth;
  rotations: number;
  probes: number;
  probeUrl: string;
  /** A group's members, without passwords, and the one in use. */
  lines: string[];
  member: number;
};

let demo: Demo | null = null;
let autoStarted = false;

/* The pretend relay says it started or stopped the way the app does (its
   "relay-changed" event), so the window reads its places again after a
   connect here exactly as it does there. */
const relayListeners = new Set<(connected: boolean) => void>();
export function onDemoRelayChanged(cb: (connected: boolean) => void): () => void {
  relayListeners.add(cb);
  return () => void relayListeners.delete(cb);
}
function tellRelayChanged(connected: boolean) {
  for (const cb of relayListeners) cb(connected);
}

/** How long the pretend relay takes to start or stop (lib/tauri.ts waits on it). */
export const pretendWait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/* What the system proxy allows, as the real app is told it: switched for you on
   a computer; on a phone never, the address goes into the Wi-Fi settings by
   hand. The phone's words are a copy of proxy-engine/hproxy-system/src/lib.rs, so
   the preview (and the store screenshots made from it) shows what a phone does. */
function support(): SystemProxySupport {
  if (!isMobile()) return { kind: "automatic", how: "browser preview, nothing is really set" };
  return {
    kind: "manual",
    why: "this operating system's proxy setting cannot be switched from here",
    steps:
      "On a phone: open the Wi-Fi settings, edit the network you are on, set the proxy to Manual with host 127.0.0.1 and the port shown here, no username or password. Apps that follow the Wi-Fi proxy then go through the relay while this app is open. When you disconnect, set the proxy back to None, or pages stop loading.",
  };
}

function idle(): ConnectStatus {
  return { running: false, system_proxy: false, support: support() };
}

function wantsAutoConnect(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("demo") === "connect";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What the pretend probe can tell, by target: like the app, only our judge and
    a Cloudflare trace page name the exit. */
function healthFor(exit: Exit, now: number, jitter: number, probeUrl: string): RelayHealth {
  const reflects = probeUrl === DEFAULT_PROBE_URL || /\/cdn-cgi\/trace\/?$/.test(probeUrl);
  const base = { ok: true, latency_ms: exit.ms + jitter, checked_at_ms: now, failures_in_a_row: 0, target: hostOf(probeUrl), reflects_exit: reflects };
  if (!reflects) return base;
  const at = CITY_AT[exit.city];
  return {
    ...base,
    exit_ip: exit.ip,
    country_code: exit.cc,
    country: exit.country,
    city: exit.city,
    asn_org: exit.asn_org,
    timezone: exit.tz,
    latitude: at?.[0] ?? null,
    longitude: at?.[1] ?? null,
  };
}

function describeRotation(r: { rule: string; n?: number }): string {
  switch (r.rule) {
    case "every_n":
      return `a different proxy every ${r.n ?? 10} connections`;
    case "every_minutes":
      return (r.n ?? 10) === 1 ? "a different proxy every minute" : `a different proxy every ${r.n ?? 10} minutes`;
    case "random":
      return "a random proxy for every connection";
    case "on_failure":
      return "the same proxy until it stops answering";
    default:
      return "a different proxy for every connection";
  }
}

function poolLabel(e: Exit, port = 80, scheme = "http"): { detail: string; in_use: string } {
  return { detail: `${e.ip}:${port} (${e.city}, ${e.cc}) ${e.ms}ms`, in_use: `${scheme}://${e.ip}:${port} (no login)` };
}

/* The Free tab's list. Every address is from the ranges set aside for
   examples (RFC 5737); the networks are the preview's usual pretend ones
   (the store pictures swap them for example names). The same country and
   protocol always give the same list and the same test answers. */

const FREE_CITIES: Record<string, string[]> = {
  US: ["Ashburn", "Dallas", "Los Angeles", "New York"],
  GB: ["London", "Manchester"],
  DE: ["Frankfurt", "Berlin", "Nuremberg"],
  FR: ["Paris", "Roubaix"],
  NL: ["Amsterdam", "Rotterdam"],
  CA: ["Toronto", "Montreal"],
  JP: ["Tokyo", "Osaka"],
  SG: ["Singapore"],
  BR: ["São Paulo", "Rio de Janeiro"],
  IN: ["Mumbai", "Bangalore"],
  AU: ["Sydney", "Melbourne"],
};
const FREE_NETWORKS = ["DigitalOcean", "Amazon AWS", "Hetzner Online", "Akamai Linode"];
const FREE_RANGES = ["192.0.2", "198.51.100", "203.0.113"];
/* The engine's own words for a proxy that fails the test (proxy-engine/
   hproxy-relay/src/pool.rs, reason_from), so the preview fails like the app. */
const FREE_FAILURES = [
  "did not answer within 10 seconds",
  "hands out its own HTTPS certificates, so it could read what you send",
  "refused the connection",
  "does not relay HTTPS",
];

/** Every free proxy the preview has listed, by host:port, so a picked one can
    be connected to with its place. */
const freeSeen = new Map<string, FreeExit>();

export async function demoFreeList(country: string | null, socks5: boolean): Promise<FreeExit[]> {
  await pretendWait(700);
  const rng = mulberry32(hashSeed(`free|${country ?? ""}|${socks5}`));
  const codes = country ? [country.toUpperCase()] : FREE_COUNTRIES.map(([c]) => c).filter(Boolean);
  const ports = socks5 ? [1080, 4145, 5678, 1088] : [8080, 3128, 80, 8888, 8000, 999];
  const list: FreeExit[] = [];
  for (let i = 0; i < 24; i++) {
    const cc = codes[Math.floor(rng() * codes.length)];
    const cities = FREE_CITIES[cc] ?? [""];
    const e: FreeExit = {
      host: `${FREE_RANGES[Math.floor(rng() * FREE_RANGES.length)]}.${1 + Math.floor(rng() * 254)}`,
      port: ports[Math.floor(rng() * ports.length)],
      country: cc,
      city: cities[Math.floor(rng() * cities.length)],
      network: FREE_NETWORKS[Math.floor(rng() * FREE_NETWORKS.length)],
      latency_ms: 60 + Math.floor(rng() * 700),
    };
    freeSeen.set(`${e.host}:${e.port}`, e);
    list.push(e);
  }
  return list;
}

/** The pool's countries as `/api/vpn/countries` gave them on 2026-09-30. */
const FREE_POOL_COUNTRIES = `
  US:1612 ID:1040 CN:306 PH:156 BR:151 RU:148 CO:144 IN:130 MX:118 FR:113 BD:108 DE:102 VN:95 EC:74 SG:72
  VE:66 AR:65 DO:52 HK:52 TH:50 JP:49 CA:48 TR:40 PE:40 NL:39 PK:37 ZA:37 KH:34 UA:32 KR:30 IR:29 GB:29 CL:28
  KE:27 AU:26 EG:26 LY:24 PL:23 MY:23 PY:21 ES:21 FI:21 NG:20 BG:19 HN:17 NP:15 IT:13 GT:13 HU:13 TW:13 CH:12
  IL:11 SY:11 GE:10 UZ:10 AE:9 KZ:9 RO:9 RS:9 SC:9 SE:9 AL:8 CZ:8 BO:8 IQ:8 IE:6 PR:6 EE:6 LV:5 AM:5 PA:5 TZ:4
  BW:4 AT:4 AF:4 BI:4 MN:4 SI:4 GH:4 KG:3 GQ:3 LB:3 MM:3 MW:3 PS:3 XK:3 SN:3 BE:3 UG:3 GR:3 SA:2 HR:2 AZ:2
  MZ:2 ME:2 CR:2 MO:2 CM:2 CG:2 SK:2 QA:2 LK:1 MA:1 BA:1 UY:1 GM:1 PG:1 CD:1 LT:1 NZ:1 BY:1 LS:1 YE:1 CY:1
  YT:1 DK:1 SL:1 JM:1 BJ:1 BF:1`;

export async function demoFreeCountries(): Promise<FreeCountry[]> {
  await pretendWait(400);
  return FREE_POOL_COUNTRIES.trim()
    .split(/\s+/)
    .map((pair) => {
      const [code, count] = pair.split(":");
      return { code, count: Number(count) };
    });
}

export async function demoFreeTest(host: string, port: number): Promise<FreeTest> {
  const rng = mulberry32(hashSeed(`test|${host}:${port}`));
  const works = rng() < 0.4;
  // A proxy that works answers in under a few seconds; one that never answers
  // takes the test's whole 10 seconds, shortened here so the preview moves.
  await pretendWait(works ? 350 + rng() * 1800 : 600 + rng() * 3400);
  if (works) return { ok: true, ms: 90 + Math.floor(rng() * 800) };
  return { ok: false, why: FREE_FAILURES[Math.floor(rng() * FREE_FAILURES.length)] };
}

/** A picked free proxy as the pretend relay's exit, with its place. */
function pickedExit(addr: string): { exit: Exit; port: number } | null {
  const e = freeSeen.get(addr);
  if (!e) return null;
  return {
    exit: {
      ip: e.host,
      cc: e.country,
      country: countryName(e.country) ?? e.country,
      city: e.city,
      asn_org: e.network,
      ms: 90 + (hashSeed(addr) % 700),
      tz: FREE_ZONES[e.country] ?? "UTC",
    },
    port: e.port,
  };
}

/** The time zone of each free country's pretend cities. */
const FREE_ZONES: Record<string, string> = {
  US: "America/New_York",
  GB: "Europe/London",
  DE: "Europe/Berlin",
  FR: "Europe/Paris",
  NL: "Europe/Amsterdam",
  CA: "America/Toronto",
  JP: "Asia/Tokyo",
  SG: "Asia/Singapore",
  BR: "America/Sao_Paulo",
  IN: "Asia/Kolkata",
  AU: "Australia/Sydney",
};

/* The pretend DNS leak test: a public resolver in the exit's country, or, for
   the exit that carries `dns`, in another one. Example addresses (RFC 5737). */
export async function demoLeakDns(): Promise<DnsLeak> {
  await pretendWait(1600);
  if (!demo) throw new Error("not connected");
  const exit = demo.picked ?? EXITS[demo.exit];
  const cc = exit.dns ?? exit.cc;
  return {
    state: "seen",
    resolvers: [
      {
        ip: `198.51.100.${53 + (hashSeed(exit.ip) % 40)}`,
        country_code: cc,
        country: countryName(cc) ?? cc,
        city: null,
        asn_org: "Google LLC",
        client_subnet: null,
      },
    ],
  };
}

/** What the pretend relay says it goes through, from the pretend library's
    lines for the place (already without passwords). */
function sourceInfo(place: Place, dialled: { lines: string[]; rule?: string; n?: number }, member: number): SourceInfo {
  if (place.kind === "proxy") return { kind: "fixed", size: 1, in_use: `http://${dialled.lines[0]}`, can_rotate: false };
  if (place.kind === "group") {
    return {
      kind: "list",
      size: dialled.lines.length,
      rotation: describeRotation({ rule: dialled.rule ?? "on_failure", n: dialled.n }),
      in_use: `http://${dialled.lines[member] ?? ""}`,
      can_rotate: true,
      member,
    };
  }
  const picked = place.exit ? pickedExit(place.exit) : null;
  const scheme = place.socks5 ? "socks5" : "http";
  return { kind: "pool", ...(picked ? poolLabel(picked.exit, picked.port, scheme) : poolLabel(EXITS[0], 80, scheme)), can_rotate: true };
}

export function demoConnectStatus(): ConnectStatus {
  if (!demo && !autoStarted && wantsAutoConnect()) {
    autoStarted = true;
    return demoConnectStart(demoSampleGroup(), true);
  }
  if (!demo) return idle();
  const now = Date.now();
  const elapsed = now - demo.startedAt;
  const down = Math.floor((elapsed / 1000) * 41.3 * 1024);
  return {
    running: true,
    listen: "127.0.0.1:8080",
    upstream: demo.source.in_use,
    // Asked for, and possible here: a phone never gets one (the engine's rule).
    system_proxy: demo.systemProxy && support().kind === "automatic",
    support: support(),
    source: demo.source,
    started_at_ms: demo.startedAt,
    stats: {
      connections: 3 + Math.floor(elapsed / 1700),
      active: 1 + (Math.floor(elapsed / 900) % 3),
      failures: 0,
      rotations: demo.rotations,
      bytes_up: Math.floor(down / 9),
      bytes_down: down,
    },
    health: demo.health,
    place: demo.place,
  };
}

/** A pretend free exit in `cc` for "Pick one for me": the country's first
    city, so the card and the map say the place that was asked for. */
function freeExitIn(cc: string): Exit | null {
  const code = cc.toUpperCase();
  const city = FREE_CITIES[code]?.[0];
  if (!city) return null;
  return {
    ip: `${FREE_RANGES[hashSeed(code) % FREE_RANGES.length]}.${20 + (hashSeed(city) % 200)}`,
    cc: code,
    country: countryName(code) ?? code,
    city,
    asn_org: FREE_NETWORKS[hashSeed(code) % FREE_NETWORKS.length],
    ms: 120 + (hashSeed(city) % 400),
    tz: FREE_ZONES[code] ?? "UTC",
  };
}

export function demoConnectStart(place: Place, systemProxy: boolean, probeUrl?: string, member?: number): ConnectStatus {
  const now = Date.now();
  const url = probeUrl?.trim() || DEFAULT_PROBE_URL;
  const picked =
    place.kind === "free"
      ? place.exit
        ? (pickedExit(place.exit)?.exit ?? null)
        : place.country
          ? freeExitIn(place.country)
          : null
      : null;
  // Read before anything changes, like the real one: a place that is gone,
  // or a member it does not have, must not cost the connection there is.
  const dialled = demoPlaceForRelay(place);
  if (!dialled) throw new Error(place.kind === "group" ? "that group is not here any more" : "that proxy is not saved here any more");
  const first = member ?? 0;
  if (place.kind === "group" && !(first >= 0 && first < dialled.lines.length)) throw new Error(noMember(first));
  const source = sourceInfo(place, dialled, first);
  demo = {
    startedAt: now,
    place,
    source,
    systemProxy,
    exit: 0,
    picked,
    freeCountry: place.kind === "free" ? place.country.toUpperCase() || null : null,
    health: healthFor(picked ?? EXITS[0], now, 0, url),
    rotations: 0,
    probes: 0,
    probeUrl: url,
    lines: place.kind === "group" ? dialled.lines : [],
    member: first,
  };
  if (place.kind === "group") demo.health = healthFor(EXITS[first % EXITS.length], now, 0, url);
  tellRelayChanged(true);
  return demoConnectStatus();
}

const noMember = (i: number) => `proxy ${i + 1} of the group is not in use: it could not be read when connecting`;

/** A group's member `i` in use from now, as the real relay does it. */
function onMember(i: number): ConnectStatus {
  if (!demo || demo.source.kind !== "list") throw new Error("only a group has proxies to pick from");
  if (!(i >= 0 && i < demo.lines.length)) throw new Error(noMember(i));
  demo.member = i;
  demo.exit = i % EXITS.length;
  demo.rotations += 1;
  demo.picked = null;
  demo.health = healthFor(EXITS[demo.exit], Date.now(), 0, demo.probeUrl);
  demo.source = { ...demo.source, in_use: `http://${demo.lines[i]}`, member: i };
  tellRelayChanged(true);
  return demoConnectStatus();
}

export function demoConnectBack(): ConnectStatus {
  if (!demo) throw new Error("not connected");
  if (demo.source.kind === "fixed") throw new Error("this is your own proxy, there is nothing to switch to");
  if (demo.source.kind === "pool") throw new Error("free proxies are found as they are needed, so there is none to go back to");
  return onMember((demo.member - 1 + demo.lines.length) % demo.lines.length);
}

export function demoConnectMember(i: number): ConnectStatus {
  if (!demo) throw new Error("not connected");
  return onMember(i);
}

export function demoConnectStop(): ConnectStatus {
  demo = null;
  tellRelayChanged(false);
  return idle();
}

/** The next pretend exit in the same free country: its next city. */
function nextFreeExit(cc: string, rotations: number): Exit | null {
  const first = freeExitIn(cc);
  const cities = FREE_CITIES[cc] ?? [];
  if (!first || !cities.length) return null;
  const city = cities[rotations % cities.length];
  return { ...first, city, ip: `${FREE_RANGES[rotations % FREE_RANGES.length]}.${30 + ((hashSeed(city) + rotations * 37) % 200)}` };
}

export function demoConnectRotate(): ConnectStatus {
  if (!demo) throw new Error("not connected");
  if (demo.source.kind === "list") return onMember((demo.member + 1) % demo.lines.length);
  demo.exit = (demo.exit + 1) % EXITS.length;
  demo.rotations += 1;
  const inCountry = demo.freeCountry ? nextFreeExit(demo.freeCountry, demo.rotations) : null;
  demo.picked = inCountry;
  const e = inCountry ?? EXITS[demo.exit];
  demo.health = healthFor(e, Date.now(), 0, demo.probeUrl);
  if (demo.source.kind === "pool") demo.source = { ...demo.source, ...poolLabel(e) };
  tellRelayChanged(true);
  return demoConnectStatus();
}

export function demoConnectProbe(): ConnectStatus {
  if (!demo) throw new Error("not connected");
  demo.probes += 1;
  demo.health = healthFor(demo.picked ?? EXITS[demo.exit], Date.now(), ((demo.probes * 7) % 23) - 11, demo.probeUrl);
  return demoConnectStatus();
}

export function demoConnectSetProbe(url: string): ConnectStatus {
  if (!demo) throw new Error("not connected");
  demo.probeUrl = url.trim() || DEFAULT_PROBE_URL;
  return demoConnectProbe();
}

export async function demoCheckLine(line: string): Promise<CheckResult> {
  await new Promise((r) => setTimeout(r, 900));
  const rng = mulberry32(hashSeed(line));
  const host = line.match(/(\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9.-]+\.[a-z]{2,})/i)?.[1] ?? line;
  if (rng() < 0.25) {
    return { input: line, alive: false, ip: host, error: "connection refused: nothing is listening on that port" };
  }
  const e = EXITS[Math.floor(rng() * EXITS.length)];
  return {
    input: line,
    alive: true,
    ip: host,
    protocols: rng() < 0.5 ? ["http", "https"] : ["socks5"],
    latency_ms: Math.round(e.ms * (0.7 + rng() * 0.8)),
    anonymity: ["elite", "anonymous", "transparent"][Math.floor(rng() * 3)],
    country_code: e.cc,
    country: e.country,
    city: e.city,
    asn_org: e.asn_org,
    exit_ip: rng() < 0.3 ? e.ip : host,
  };
}

/* The pretend time zone match. The preview changes no clock: it plays the
   answers of src-tauri/src/timezone.rs and says which zone its pretend clock
   shows, so the leak check's time zone line can be seen matched. */
let demoMatching = false;

export function demoZoneStatus(): ZoneStatus {
  const exitZone = demo?.health?.ok ? (demo.health.timezone ?? null) : null;
  // Like the real one: a clock already on the exit's zone is left as it is,
  // so there is nothing matched to say.
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const matched = demoMatching && !!exitZone && exitZone !== local;
  return {
    supported: !isMobile(),
    matching: demoMatching,
    matched: matched ? "Pretend Standard Time" : null,
    matched_at_ms: matched ? (demo?.startedAt ?? null) : null,
    automatic: true,
    problem: null,
    preview_clock: matched ? exitZone : null,
  };
}

export async function demoZoneSetMatching(on: boolean): Promise<ZoneStatus> {
  await pretendWait(300);
  demoMatching = on;
  return demoZoneStatus();
}

export async function demoZoneMatchAgain(): Promise<ZoneStatus> {
  await pretendWait(300);
  return demoZoneStatus();
}
