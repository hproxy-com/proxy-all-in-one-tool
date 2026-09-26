/* BROWSER PREVIEW ONLY. In the real app this never runs: the UI calls the
   engine. It exists so the design can be reviewed (and screenshotted) in a
   plain browser without a live judge. Seeded from the list so re-runs match.
   Nothing in here may be imported by production code paths. */

import { countryName, type LeakedHeader, type Row, type Status } from "./checker";

const SIM_GEO: { cc: string; cities: string[] }[] = [
  { cc: "us", cities: ["Ashburn", "Dallas", "Los Angeles"] },
  { cc: "de", cities: ["Frankfurt", "Berlin"] },
  { cc: "nl", cities: ["Amsterdam", "Rotterdam"] },
  { cc: "gb", cities: ["London", "Manchester"] },
  { cc: "fr", cities: ["Paris", "Roubaix"] },
  { cc: "sg", cities: ["Singapore"] },
  { cc: "jp", cities: ["Tokyo", "Osaka"] },
  { cc: "ca", cities: ["Toronto", "Montreal"] },
];

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIM_SERVERS = ["Squid", "MikroTik", "Tinyproxy", "HAProxy", undefined] as const;

/* Real, well-known networks rather than a fresh random ASN per row.
 *
 * The previous version minted `AS${13335 + random * 50000}` for every row, so
 * no simulated list ever repeated a network. That makes the per-ASN rollup and
 * the insights panel literally unreviewable in a browser preview: every network
 * has a sample of one, and every claim is correctly suppressed for being too
 * thin. A preview that cannot show the feature is not a preview of the app. */
const SIM_NETWORKS: { asn: number; org: string }[] = [
  { asn: 14061, org: "DigitalOcean" },
  { asn: 16509, org: "Amazon AWS" },
  { asn: 24940, org: "Hetzner Online" },
  { asn: 63949, org: "Akamai Linode" },
  { asn: 7922, org: "Comcast Cable" },
  { asn: 3320, org: "Deutsche Telekom" },
  { asn: 4134, org: "China Telecom" },
  { asn: 45899, org: "VNPT" },
];

/* Why a simulated proxy did not work: the engine's own failure words and its
   own sentences (engine/hproxy-probe/src/result.rs, `sentence`), so the dead
   rows in a preview read exactly as they will in the app. */
const SIM_FAILURES: { failure: string; reason: string }[] = [
  { failure: "refused", reason: "connection refused in 38 ms: nothing is listening on that port" },
  { failure: "refused", reason: "connection refused in 112 ms: nothing is listening on that port" },
  { failure: "timeout", reason: "no answer to the connection after 10.0 s" },
  { failure: "auth_required", reason: "the proxy wants a username and password (407)" },
  { failure: "no_echo", reason: "answered 200, but it is not a proxy: the reply was its own page, not our judge" },
  { failure: "transport_error", reason: "the connection broke before a reply arrived" },
];

export function simulateRow(row: Row, rng: () => number): Row {
  const roll = rng();
  const failed = roll < 0.62 ? undefined : SIM_FAILURES[Math.floor(rng() * SIM_FAILURES.length)];
  const status: Status = !failed ? "working" : failed.failure === "timeout" ? "timeout" : "dead";
  const g = SIM_GEO[Math.floor(rng() * SIM_GEO.length)];
  const net = SIM_NETWORKS[Math.floor(rng() * SIM_NETWORKS.length)];

  /* Dead rows carry their location and network too, because the real engine
     does: the geo lookup runs before the liveness branch, so an address is
     labelled whether or not the proxy answers. Leaving them bare here would
     make every network in the insights panel read "100% alive", which is both
     obviously false and the exact number the panel exists to get right. */
  const labelled = {
    cc: g.cc,
    country: countryName(g.cc),
    city: g.cities[Math.floor(rng() * g.cities.length)],
    isp: net.org,
    asn: `AS${net.asn}`,
  };
  if (failed) return { ...row, status, ...labelled, failure: failed.failure, reason: failed.reason };
  const proto = (["HTTP", "HTTPS", "SOCKS5"] as const)[Math.floor(rng() * 3)];
  const anon = (["Elite", "Anonymous", "Transparent"] as const)[Math.floor(rng() * 3)];

  /* Every protocol the address answers on, in the engine's order. Most HTTP
     proxies also tunnel HTTPS (CONNECT), SOCKS servers often speak 4 and 5, and
     a few servers answer on all four; a preview with one protocol per row hid
     the four-chip row that ran into its neighbour (2026-09-24). Read off `roll`,
     which is already drawn, so every other number in the preview stays the same. */
  const protocols =
    roll < 0.08
      ? ["http", "https", "socks4", "socks5"]
      : roll < 0.3
        ? proto === "SOCKS5"
          ? ["socks4", "socks5"]
          : ["http", "https"]
        : [proto.toLowerCase()];

  /* Split the latency into phases the same way the real engine does, so the
     detail view has something correctly shaped to render in a plain browser.
     Connect is distance and TTFB is the proxy plus its upstream fetch, which is
     precisely the distinction the breakdown exists to expose. A preview that
     invented one flat number would hide the feature it is meant to show. */
  const connect = Math.max(1, Math.round((40 + rng() * 300) * (0.2 + rng() * 0.3)));
  const handshake = proto === "SOCKS5" ? Math.max(1, Math.round(connect * 0.6)) : undefined;
  const tls = proto === "HTTPS" ? Math.max(1, Math.round(connect * 0.9)) : undefined;
  const ttfb = Math.max(8, Math.round(30 + rng() * 260));
  const total = connect + (handshake ?? 0) + (tls ?? 0) + ttfb;

  /* The engine times every protocol that answered. The others reuse the first
     one's distance, with their own handshake and a few ms more waiting. */
  const otherTiming = (p: string, i: number) => {
    const hs = p.startsWith("socks") ? Math.max(1, Math.round(connect * 0.6)) : null;
    const tl = p === "https" ? Math.max(1, Math.round(connect * 0.9)) : null;
    const wait = ttfb + i * 7;
    return {
      protocol: p,
      timings: { dns_ms: null, connect_ms: connect, handshake_ms: hs, tls_ms: tl, ttfb_ms: wait, total_ms: connect + (hs ?? 0) + (tl ?? 0) + wait },
    };
  };

  /* Roughly one proxy in six exits somewhere other than where you dialled it,
     which is about what a scraped list looks like. */
  const rotating = rng() < 0.17;
  const exitIp = rotating
    ? `${45 + Math.floor(rng() * 180)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}`
    : row.host;

  const leaks: LeakedHeader[] =
    anon === "Transparent"
      ? [{ name: "x-forwarded-for", value: "203.0.113.44" }, { name: "via", value: "1.1 gateway" }]
      : anon === "Anonymous"
        ? [{ name: "via", value: "1.1 proxy (squid/5.7)" }]
        : [];

  return {
    ...row,
    ...labelled,
    status,
    protocol: proto,
    protocols,
    anonymity: anon,
    latency: total,
    exitIp,
    rotating,
    server: SIM_SERVERS[Math.floor(rng() * SIM_SERVERS.length)],
    leaks: leaks.length ? leaks : undefined,
    keepAlive: rng() < 0.5 ? true : undefined,
    timings: [
      {
        protocol: proto.toLowerCase(),
        timings: {
          dns_ms: null,
          connect_ms: connect,
          handshake_ms: handshake ?? null,
          tls_ms: tls ?? null,
          ttfb_ms: ttfb,
          total_ms: total,
        },
      },
      ...protocols.filter((p) => p !== proto.toLowerCase()).map((p, i) => otherTiming(p, i + 1)),
    ],
  };
}
