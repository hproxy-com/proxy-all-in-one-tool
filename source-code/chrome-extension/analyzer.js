/* ============================================================
   ANALYZER: what is actually true about this connection.

   The brief (2026-08-02): one tool that connects a proxy and analyzes it
   at the same time, and says whether DNS is leaking and whether
   everything else is sound.

   So connecting and checking are ONE motion. Every connect produces a
   verdict without anyone visiting a diagnostics page, because a
   diagnostics page you have to remember to open is one nobody opens.

   ── THE RULE THIS FILE IS BUILT ON ──────────────────────────────────
   A check that cannot answer says so. It never guesses, and it never
   reports a pass it did not measure. A security tool that says "clean"
   when it means "did not look" is worse than no tool, because the user
   acts on it. `unknown` is a first-class status here, not an error.

   ── THE SAME RULES AS THE CHECKING ENGINE ───────────────────────────
   The desktop app and the command-line tool grade proxies with the
   engine in the open-source hproxy-checker app. This file follows its
   rules, learned from the website's own incidents:

   1. The exit is the address our server saw the connection come from
      (`peer_ip`, set by our own edge). Never `ip`: that field prefers
      X-Forwarded-For, which the proxy writes. And the exit differing from
      the address dialled is NORMAL for a rotating gateway, which is what
      every residential plan is.
   2. "Not going through the proxy" means YOUR OWN address reached us.
      The worker learns it before it switches the proxy on.
   3. Header leaks are read only from our plain-HTTP judge, which has no
      CDN in front of it. probe.hproxy.com sits behind Cloudflare, which
      adds x-forwarded-for and x-real-ip to every request: graded on
      that, every proxy on earth would read "anonymous". And a tunnel
      (HTTPS, SOCKS) cannot add a header at all.

   ── WHERE EACH PROBE GOES ───────────────────────────────────────────
   background.js bypasses the proxy for hproxy.com itself, so failover
   can fetch a fresh exit while the current one is dead. A fetch to
   hproxy.com therefore goes DIRECT (that is how we learn your own
   address), and a probe that must cross the tunnel goes to a subdomain.
   ============================================================ */

import { isIPv4, isIPv6 } from "./line.js";

const API = "https://hproxy.com";

/* Reached THROUGH the tunnel: its answer names the exit. Behind Cloudflare,
   so its headers are Cloudflare's and are never graded. */
const PROBE_ORIGIN = "https://probe.hproxy.com";

/* Our plain-HTTP judge, no CDN in front: the only forwarding headers it can
   see are the ones the proxy added. 8080 first, because residential
   gateways refuse odd ports and allow 80, 443 and 8080. One constant each,
   so moving the judge is a one-line change. */
export const PLAIN_JUDGES = [
  "http://echo.hproxy.com:8080/api/free-proxy/echo",
  "http://echo.hproxy.com:4505/api/free-proxy/echo",
];

/* Where the worker keeps the addresses this browser has without a proxy. */
export const REAL_IPS_KEY = "hproxy_real_ips";

/* Headers a proxy adds that reveal a proxy was here, and sometimes who is
   behind it. The engine's list (grade.rs), without `proxy-connection`: the
   browser's own requests may carry that one, and it identifies nobody.
   `x-real-peer` is absent on purpose: it is how our own edge names the true
   peer, and counting it would grade every proxy anonymous. */
export const LEAK_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "via",
  "forwarded",
  "x-proxy-id",
  "client-ip",
  "x-client-ip",
  "x-forwarded",
  "forwarded-for",
];

/* Statuses, in the order a verdict sorts them. `bad` first: if something
   is leaking, it is the only thing the user should read first. */
export const STATUS = { bad: 0, warn: 1, unknown: 2, ok: 3, skip: 4 };

/* ── helpers ────────────────────────────────────────────────────────── */

async function getJson(url, { ms = 8000, headers } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctl.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** A public address, or null. Loopback and private values are proof a field
    did not come from where we think it did. */
export function publicIp(value) {
  const ip = String(value || "").split(",")[0].trim();
  if (isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    const private4 = a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    return private4 ? null : ip;
  }
  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower)) return null;
    return ip;
  }
  return null;
}

/** The address a judge saw on the wire, reading through our edge the way the
    engine does: when `ip` is loopback or empty, our nginx names the true peer
    in `x-real-peer`. */
export function wireIp(echo) {
  const ip = String(echo?.ip || "").trim();
  const local = !ip || ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0";
  if (local) return String(echo?.headers?.["x-real-peer"] || "").trim();
  return ip;
}

/** Three tiers, the engine's rule: the judge saw one of YOUR addresses, on the
    wire or in a forwarding header: transparent. Else any proxy header:
    anonymous. Else elite. Returns the tier and the evidence. */
export function gradeEcho(echo, realIps) {
  const headers = echo?.headers || {};
  const leaks = Object.entries(headers)
    .filter(([k]) => LEAK_HEADERS.includes(k.toLowerCase()))
    .map(([k, v]) => ({ name: k.toLowerCase(), value: String(v) }));
  const mine = (realIps || []).filter(Boolean);
  const wire = wireIp(echo);
  const exposed = mine.length > 0 && (mine.includes(wire) || leaks.some((h) => mine.some((ip) => h.value.includes(ip))));
  if (exposed) return { tier: "transparent", leaks };
  return { tier: leaks.length ? "anonymous" : "elite", leaks };
}

export function medianMs(samples) {
  if (!samples.length) return null;
  const sorted = samples.slice().sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]);
}

async function storedRealIps() {
  try {
    const area = chrome.storage.session || chrome.storage.local;
    const o = await area.get(REAL_IPS_KEY);
    return Array.isArray(o?.[REAL_IPS_KEY]) ? o[REAL_IPS_KEY] : [];
  } catch {
    return [];
  }
}

/** Everything the checks share, fetched once: your own addresses, the exit,
    where the exit is. */
async function gatherFacts() {
  const t = Date.now();
  const [direct, tunnel, stored] = await Promise.all([
    getJson(`${API}/api/free-proxy/echo?d=${t}`).catch(() => null),
    getJson(`${PROBE_ORIGIN}/api/free-proxy/echo?t=${t}`).catch((e) => ({ failed: e.message || String(e) })),
    storedRealIps(),
  ]);
  const realIps = [...new Set([publicIp(direct?.peer_ip), ...stored.map(publicIp)].filter(Boolean))];
  const exit = tunnel && !tunnel.failed ? publicIp(tunnel.peer_ip) : null;
  const geo = exit ? await getJson(`${API}/api/ip/${encodeURIComponent(exit)}`).catch(() => null) : null;
  return { realIps, exit, tunnelFailed: tunnel?.failed || null, geo };
}

/* ── the checks ─────────────────────────────────────────────────────── */
/* Each returns { id, label, status, headline, detail, fix? }.
   `fix` names an action the extension can actually perform. A finding
   the user cannot act on is a complaint, not a diagnostic. */

/** Where the world places you, measured through the tunnel. */
async function checkExit(ctx) {
  const base = { id: "exit", label: "Exit address" };
  if (!ctx.active) {
    return { ...base, status: "skip", headline: "Not connected", detail: "You are browsing on your own IP." };
  }
  const f = await ctx.facts;
  if (!f.exit) {
    return {
      ...base,
      status: "unknown",
      headline: "The far end did not answer",
      detail: `Our server could not be reached through this proxy${f.tunnelFailed ? ` (${f.tunnelFailed})` : ""}.`,
    };
  }
  if (f.realIps.includes(f.exit)) {
    return {
      ...base,
      status: "bad",
      headline: "Your own address reaches sites",
      detail: `Our server saw ${f.exit}, which is your own connection. Traffic is not going through the proxy.`,
    };
  }
  const g = f.geo || {};
  const where = [g.country_name || g.country, g.isp || g.asn_org].filter(Boolean).join(" · ");
  const dialled = String(ctx.active.host || "");
  const elsewhere = (isIPv4(dialled) || isIPv6(dialled)) && dialled !== f.exit;
  return {
    ...base,
    status: "ok",
    headline: f.exit,
    detail: [where || "Located, but the network was not named.", elsewhere ? "Leaves by another address than the one dialled, as a rotating gateway does." : ""]
      .filter(Boolean)
      .join(" "),
    meta: { country: g.country || "", asn: g.asn ? `AS${g.asn}` : "", datacenter: !!g.is_datacenter },
  };
}

/**
 * Is the proxy telling the far end who you are?
 *
 * Only plain HTTP can carry a header a proxy added: an HTTPS page travels
 * inside a tunnel the proxy cannot write into, and SOCKS relays bytes. So
 * the question is asked of our plain-HTTP judge, through the proxy.
 */
async function checkTransparency(ctx) {
  const base = { id: "transparency", label: "Header leaks" };
  if (!ctx.active) return { ...base, status: "skip", headline: "Not connected", detail: "" };
  if (String(ctx.active.scheme || "").startsWith("socks")) {
    return { ...base, status: "ok", headline: "Nothing can be added", detail: "A SOCKS proxy relays your requests unchanged." };
  }
  const f = await ctx.facts;
  const nonce = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  let echo = null;
  for (const url of PLAIN_JUDGES) {
    try {
      const got = await getJson(`${url}?n=${nonce}`, { ms: 6000, headers: { "x-hproxy-probe": nonce } });
      // Only our judge knows the value we just sent. A portal or a cache that
      // answers every request cannot fake it.
      if (got?.headers?.["x-hproxy-probe"] === nonce) {
        echo = got;
        break;
      }
    } catch {
      /* next judge */
    }
  }
  if (!echo) {
    return {
      ...base,
      status: "unknown",
      headline: "Plain HTTP not measured",
      detail: "Our plain-HTTP judge could not be reached through this proxy. HTTPS pages cannot carry added headers either way.",
    };
  }
  const { tier, leaks } = gradeEcho(echo, f.realIps);
  const list = leaks.map((h) => `${h.name}: ${h.value}`).join(", ");
  if (tier === "transparent") {
    return { ...base, status: "bad", headline: "Tells sites your address", detail: `On plain HTTP pages the proxy forwards your real address (${list || "on the wire"}).` };
  }
  if (tier === "anonymous") {
    return { ...base, status: "warn", headline: "Anonymous, not elite", detail: `The proxy announces itself on plain HTTP pages: ${list}.` };
  }
  return { ...base, status: "ok", headline: "Elite", detail: "Nothing about you or the proxy is added." };
}

/**
 * DNS.
 *
 * On a proxy, Chrome hands the HOSTNAME to the proxy and the PROXY resolves
 * it. So the resolver worth knowing is the proxy's, and the question is
 * whether it sits where the exit claims to be. Measuring that needs
 * authoritative nameservers we run. Not built, so not claimed.
 */
async function checkDns(ctx) {
  const base = { id: "dns", label: "DNS resolver" };
  if (!ctx.active) return { ...base, status: "skip", headline: "Not connected", detail: "" };
  return {
    ...base,
    status: "unknown",
    headline: "Not measured yet",
    detail: "Chrome sends names to the proxy to resolve. Which resolver the proxy uses needs nameservers we run; not built, so not claimed.",
  };
}

/**
 * WebRTC.
 *
 * Chrome can open peer connections that ignore the proxy entirely and
 * expose your real address. This one the extension can FIX, by setting the
 * browser's WebRTC IP handling policy, so the finding carries the action.
 */
async function checkWebrtc(ctx) {
  const base = { id: "webrtc", label: "WebRTC" };
  /* With nothing connected there is no proxy to go around. It used to warn
     here anyway, with a button that changed a browser-wide setting while
     nothing was proxied. The worker now locks WebRTC on connect and releases
     it on disconnect, so this row only speaks while a proxy is on. */
  if (!ctx.active) return { ...base, status: "skip", headline: "Not connected", detail: "" };
  if (!("chrome" in globalThis) || !chrome.privacy?.network?.webRTCIPHandlingPolicy) {
    return { ...base, status: "unknown", headline: "Cannot read the policy", detail: "The extension needs the `privacy` permission to see or change this." };
  }
  const policy = await new Promise((r) => chrome.privacy.network.webRTCIPHandlingPolicy.get({}, (d) => r(d?.value || "")));
  if (policy === "disable_non_proxied_udp") {
    return { ...base, status: "ok", headline: "Locked to the proxy", detail: "Peer connections cannot go around the tunnel." };
  }
  return {
    ...base,
    status: "warn",
    headline: "Can go around the proxy",
    detail: `Policy is "${policy || "default"}". A site opening a peer connection may see your real address.`,
    fix: { id: "lock-webrtc", label: "Lock WebRTC to the proxy" },
  };
}

/** The exit's country: from the exit itself when it answered. */
async function exitCountry(ctx) {
  const f = await ctx.facts;
  return String(f?.geo?.country || ctx.active?.country || "").toUpperCase();
}

/** Does the clock agree with where you appear to be? */
async function checkTimezone(ctx) {
  const base = { id: "timezone", label: "Time zone" };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  if (!ctx.active) return { ...base, status: "skip", headline: tz, detail: "" };
  const country = await exitCountry(ctx);
  if (!tz || !country) return { ...base, status: "unknown", headline: tz || "Unknown", detail: "Nothing to compare it against." };
  /* Deliberately coarse: continent agreement, not city. A US exit with a
     Europe/Berlin clock is a real signal; America/Chicago against a New York
     exit is noise, and flagging noise teaches people to ignore the panel. */
  const region = tz.split("/")[0];
  const expected = REGION_BY_COUNTRY[country];
  if (!expected) return { ...base, status: "unknown", headline: tz, detail: `No expected region on file for ${country}.` };
  if (expected.includes(region)) return { ...base, status: "ok", headline: tz, detail: `Consistent with a ${country} exit.` };
  return { ...base, status: "warn", headline: tz, detail: `Your clock says ${region}, your exit says ${country}. Sites that compare the two can tell.` };
}

function localeCountry(tag) {
  const m = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(String(tag || ""));
  return m ? m[1].toUpperCase() : null;
}

/** Does the browser's language agree with where you appear to be? */
async function checkLocale(ctx) {
  const base = { id: "locale", label: "Language" };
  const langs = (navigator.languages || [navigator.language]).filter(Boolean);
  const shown = langs.slice(0, 3).join(", ");
  if (!ctx.active) return { ...base, status: "skip", headline: shown, detail: "" };
  const country = await exitCountry(ctx);
  const claimed = langs.map(localeCountry).filter(Boolean);
  if (!country || !claimed.length) {
    return { ...base, status: "unknown", headline: shown, detail: "Your locale does not name a country, so there is nothing to contradict." };
  }
  if (claimed.includes(country)) return { ...base, status: "ok", headline: shown, detail: `Consistent with a ${country} exit.` };
  return { ...base, status: "warn", headline: shown, detail: `Your browser asks for ${claimed[0]} content from a ${country} address.` };
}

/** How much the tunnel costs, measured through it. */
async function checkLatency(ctx) {
  const base = { id: "latency", label: "Round trip" };
  if (!ctx.active) return { ...base, status: "skip", headline: "Not connected", detail: "" };
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    try {
      const res = await fetch(`${PROBE_ORIGIN}/api/free-proxy/echo?l=${i}-${Date.now()}`, { cache: "no-store" });
      if (res.ok) samples.push(performance.now() - t);
    } catch {
      /* one failed sample is not a verdict; three are */
    }
  }
  const ms = medianMs(samples);
  if (ms === null) {
    /* `dead`, not a leak: the verdict must say "not working", never
       "leaking", for a proxy that simply carries nothing. */
    return { ...base, status: "bad", kind: "dead", headline: "No response", detail: "Nothing came back through the proxy. It is not carrying traffic." };
  }
  /* Slow is something to know, never "leaking". */
  return {
    ...base,
    status: ms < 400 ? "ok" : "warn",
    headline: `${ms} ms`,
    detail: `Median of ${samples.length} round trips through the proxy to our server.${ms >= 1200 ? " Slow: pages will take a while." : ""}`,
    samples: samples.map((s) => Math.round(s)),
  };
}

/* Coarse expected tz regions per country. Only used to avoid crying wolf,
   so a missing entry yields `unknown` rather than a false alarm. */
const REGION_BY_COUNTRY = {
  US: ["America"], CA: ["America"], MX: ["America"], BR: ["America"], AR: ["America"],
  GB: ["Europe"], DE: ["Europe"], FR: ["Europe"], NL: ["Europe"], ES: ["Europe"],
  IT: ["Europe"], PL: ["Europe"], SE: ["Europe"], CH: ["Europe"], IE: ["Europe"],
  RU: ["Europe", "Asia"], TR: ["Europe", "Asia"],
  JP: ["Asia"], CN: ["Asia"], IN: ["Asia"], SG: ["Asia"], ID: ["Asia"],
  KR: ["Asia"], HK: ["Asia"], TW: ["Asia"], VN: ["Asia"], TH: ["Asia"],
  AU: ["Australia"], NZ: ["Pacific"],
  ZA: ["Africa"], NG: ["Africa"], EG: ["Africa"], KE: ["Africa"],
};

/* ── the run ────────────────────────────────────────────────────────── */

const CHECKS = [checkExit, checkTransparency, checkDns, checkWebrtc, checkTimezone, checkLocale, checkLatency];

/**
 * Run every check against the current session.
 *
 * The facts every check shares (your addresses, the exit, its place) are
 * fetched once. Checks run CONCURRENTLY and each owns its failure: a thrown
 * check becomes an `unknown` row, never a dead panel.
 */
export async function analyze(active, onRow) {
  const ctx = { active, facts: active ? gatherFacts() : Promise.resolve(null) };
  const rows = await Promise.all(
    CHECKS.map(async (check) => {
      try {
        const row = await check(ctx);
        onRow?.(row);
        return row;
      } catch (e) {
        const row = { id: check.name, label: check.name, status: "unknown", headline: "Check failed", detail: e?.message || String(e) };
        onRow?.(row);
        return row;
      }
    }),
  );

  rows.sort((a, b) => STATUS[a.status] - STATUS[b.status]);

  /* Not-connected is decided HERE, from `active`, not inferred from the rows:
     WebRTC answers either way, and inferring made the verdict read "Clean so
     far" over a completely unprotected connection. */
  if (!active) {
    return {
      rows,
      verdict: { status: "skip", headline: "Not connected", detail: "You are browsing on your own IP. Connect a proxy and it gets checked straight away." },
    };
  }
  return { rows, verdict: verdictFor(rows) };
}

/**
 * One line for the top. Deliberately not a score out of 100: a score invites
 * feeling fine at 82 without reading which 18 were lost.
 */
export function verdictFor(rows) {
  const live = rows.filter((r) => r.status !== "skip");
  const bad = live.filter((r) => r.status === "bad");
  const warn = live.filter((r) => r.status === "warn");
  const unknown = live.filter((r) => r.status === "unknown");

  if (!live.length) return { status: "skip", headline: "Not connected", detail: "Connect a proxy to analyze it." };
  /* A leak exposes you. A dead proxy exposes nothing, it just does not work,
     and calling that "leaking" sent people hunting for a privacy problem
     that did not exist (seen 2026-09-23 on a free exit that re-signs HTTPS). */
  const leaks = bad.filter((r) => r.kind !== "dead");
  if (leaks.length) {
    return { status: "bad", headline: leaks.length === 1 ? "1 thing is leaking" : `${leaks.length} things are leaking`, detail: leaks.map((r) => r.label).join(", ") };
  }
  if (bad.length) {
    return { status: "bad", headline: "Not carrying traffic", detail: "Nothing came back through this proxy, so pages will not load through it." };
  }
  if (warn.length) {
    return { status: "warn", headline: warn.length === 1 ? "1 thing to tighten" : `${warn.length} things to tighten`, detail: warn.map((r) => r.label).join(", ") };
  }
  if (unknown.length) {
    /* Never call it clean while something went unmeasured. */
    return {
      status: "unknown",
      headline: "Clean so far",
      detail: `${unknown.length} check${unknown.length === 1 ? "" : "s"} could not run: ${unknown.map((r) => r.label).join(", ")}.`,
    };
  }
  return { status: "ok", headline: "Everything checks out", detail: "Nothing is leaking and nothing looks inconsistent." };
}
