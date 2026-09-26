// HProxy extension: the background service worker.
//
// This worker is the PERSISTENT brain of the extension. The popup is only a
// remote control that opens and closes; the connection itself (which proxy is
// active, moving to a fresh exit, healing when one dies) lives HERE, so it
// keeps working after the popup is gone and survives MV3 worker recycling:
// state is mirrored to chrome.storage.local and read back on wake.
//
// Two connection modes:
//   • "vpn" — free exits from the public pool. Every exit is TESTED before
//             any page goes through it (findWorkingExit), and when one dies
//             mid-browse it is checked first, then replaced by the next exit
//             that passes the same test.
//   • "pin" — a proxy the person chose: their own, or an HProxy plan line.
//             Logins are answered from memory in onAuthRequired. A pin is
//             never moved automatically.
//
// The engine does the IP intelligence; this worker does the browser plumbing.

const API = "https://hproxy.com";
const SESSION_KEY = "hproxy_session";

/* The test every free exit must pass before traffic moves to it, and the
   check a failing exit gets before it is replaced.

   probe.hproxy.com sits behind Cloudflare with a certificate every browser
   trusts, and it is NOT on the bypass list, so this request crosses the
   proxy. It passes only when Chrome itself accepted the certificate, which
   is exactly what a proxy that re-signs HTTPS cannot fake.

   Why the test exists (measured 2026-09-23 in Chrome for Testing, 30 exits
   in the order the pool ranks them): 2 worked. 25 re-signed HTTPS with a
   forged certificate ("None, LLC", Dallas) and 3 refused HTTPS outright.
   The engine counts all 28 as alive because its own check accepts any
   certificate. Without this test, Quick Connect handed people a red
   "Your connection is not private" page on every site. */
const PROBE_URL = "https://probe.hproxy.com/api/free-proxy/echo";
const PROBE_HOST = "probe.hproxy.com";
const PROBE_TIMEOUT_MS = 5000;

/* How far one Quick Connect, New IP or automatic heal searches. */
const MAX_EXITS_PER_SEARCH = 12;
/* Candidates come from /api/vpn/pool: the same ranking /api/vpn/next walks,
   50 per request and cached at the edge, so one search costs our server one
   request instead of one per exit tried. */
const POOL_BATCH = 50;
const POOL_TTL_MS = 3 * 60 * 1000;
/* An exit that failed the test is not offered again for this long. */
const BAD_EXIT_TTL_MS = 30 * 60 * 1000;
const RECENT_MAX = 12; // exits New IP will not hand back

/* A dying exit fails a burst of requests at once: one check per burst. */
const FAILOVER_DEBOUNCE_MS = 1500;
/* Automatic heals in a row that found nothing. Then the worker stops trying
   on its own, the badge turns amber, and the next move is the person's. */
const MAX_FAILED_HEALS = 3;

const POOL_KEY_PREFIX = "hproxy_pool:";
const BAD_EXITS_KEY = "hproxy_bad_exits";
const OWN_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

// ── In-memory state (rebuilt from storage on wake) ──────────────────────────
let failoverTimer = null;
let failedHeals = 0;
/* A connect, New IP or heal is running. Errors seen meanwhile belong to the
   search itself and never start another one. */
let busy = false;
/* The free exit a probe is testing right now. A 407 from it means it is not
   a free exit: refused, never shown to the person as a login box. */
let testingHost = null;
/* Disconnect stops a running search between two exits. */
let stopRequested = false;
let probeAbort = null;

class Stopped extends Error {
  constructor() {
    super("Stopped");
    this.stopped = true;
  }
}

/* One connection change at a time, in the order asked. A second click on
   Quick Connect waits for the first instead of racing it for Chrome's one
   proxy setting. `queued` counts what is waiting or running, so the status
   check can tell "a search owns the setting right now" from "the setting
   was lost". */
let queue = Promise.resolve();
let queued = 0;
function serial(task) {
  queued += 1;
  const run = queue.then(
    () => task(),
    () => task(),
  );
  queue = run.catch(() => {});
  run.finally(() => (queued -= 1)).catch(() => {});
  return run;
}
/* What the running task is doing, for the popup: "search" (free exits are
   being tested) or "test" (a proxy of their own is being tried). */
let busyWith = null;

// ── Login cache (the reason authenticated proxies do not time out) ──────────
// onAuthRequired must answer FAST. Reading chrome.storage.local on every 407
// adds async latency, and right after the MV3 worker wakes with several
// requests queued those reads race and the CONNECT tunnel times out
// (ERR_TUNNEL_CONNECTION_FAILED), a known failure of MV3 proxy extensions.
// So the active proxy's login lives here, answered
// synchronously; storage is read at most once per cold wake.
let activeCreds = null; // { username, password } of the active proxy, or null
let activeMode = null; // "vpn" | "pin" | null
let hydrated = false;
let hydration = null; // shared promise: N queued challenges, ONE storage read

function hydrate() {
  if (!hydration) {
    hydration = loadSession().then((s) => {
      if (!hydrated) remember(s);
    });
  }
  return hydration;
}

/** Memory follows the session: called on connect, disconnect and wake. */
function remember(session) {
  activeMode = session?.mode || null;
  activeCreds = session?.proxy?.username
    ? { username: session.proxy.username, password: session.proxy.password || "" }
    : null;
  hydrated = true;
  hydration = Promise.resolve();
}

/* Requests that already got the login once. Chrome asks again for the SAME
   request when the proxy refuses the login, and answering again with the
   same wrong password loops: the page spins, the proxy logs a flood of
   failures (some providers lock the account for it), and nothing tells the
   person why. The second ask cancels, and every later ask from that proxy is
   cancelled without sending the password again, until they reconnect. */
const answeredAuth = new Set();
let loginRefused = false;
/* A proxy of the person's own under test (pinFind): its login, answered once
   from memory while only the probe goes through it, and whether it refused. */
let testingCreds = null;
let testLoginRefused = false;

/* This browser's own public addresses, learned before a proxy is switched
   on. The analyzer needs them twice: "your own address reached our server"
   is how it knows traffic is NOT going through the proxy, and a proxy that
   forwards one of them is transparent. hproxy.com is dual-stack and always
   reached directly (bypass list), echo.hproxy.com is IPv4 only, so the two
   together give both families. */
const REAL_IPS_KEY = "hproxy_real_ips";
async function learnRealIps() {
  const grab = async (url) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
      const j = await r.json();
      return typeof j?.peer_ip === "string" ? j.peer_ip : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const ips = (
    await Promise.all([
      grab(`${API}/api/free-proxy/echo?own=${Date.now()}`),
      grab(`http://echo.hproxy.com:8080/api/free-proxy/echo?own=${Date.now()}`),
    ])
  ).filter(Boolean);
  if (!ips.length) return;
  try {
    await chrome.storage.session.set({ [REAL_IPS_KEY]: [...new Set(ips)] });
  } catch {
    // The analyzer then says it could not prove transparency, never guesses.
  }
}

async function isOwnAddress(ip) {
  try {
    const o = await chrome.storage.session.get(REAL_IPS_KEY);
    return Array.isArray(o?.[REAL_IPS_KEY]) && o[REAL_IPS_KEY].includes(ip);
  } catch {
    return false;
  }
}

/* Tell an open popup that something changed, instead of it asking every
   few seconds. No popup open is the normal case and not an error. */
function notifyStatus() {
  try {
    chrome.runtime.sendMessage({ type: "statusChanged" }).catch(() => {});
  } catch {
    // no listener
  }
}

// ── Session persistence ─────────────────────────────────────────────────────
function loadSession() {
  return new Promise((r) => chrome.storage.local.get(SESSION_KEY, (o) => r(o?.[SESSION_KEY] || null)));
}
function saveSession(s) {
  return new Promise((r) => chrome.storage.local.set({ [SESSION_KEY]: s }, () => r()));
}

// ── chrome.proxy plumbing ───────────────────────────────────────────────────
const SCHEMES = { http: "http", https: "https", socks4: "socks4", socks5: "socks5" };
function schemeFor(s) {
  return SCHEMES[String(s || "").toLowerCase()] || "http";
}

// Fixed-server config for one proxy. We BYPASS hproxy.com (+ loopback) so the
// extension's own control-plane calls (/api/vpn/pool, /api/vpn/report, /v1/*)
// always go DIRECT: that is what lets a heal fetch fresh exits even while the
// current one is dead.
function proxyConfig(proxy) {
  return {
    mode: "fixed_servers",
    rules: {
      singleProxy: {
        scheme: schemeFor(proxy.scheme),
        host: proxy.host,
        port: Number(proxy.port),
      },
      /* ⚠️ The wildcard `*.hproxy.com` is deliberately GONE (2026-08-02).
         Only the apex needs to skip the tunnel: the control plane lives
         entirely at https://hproxy.com (/api/vpn/*, /api/v1/*), and that
         bypass is what lets a heal fetch fresh exits while the current
         one is dead.

         Exempting every SUBDOMAIN as well was defensive and cost us the
         only thing that can answer "what does the world see through this
         proxy": a host on the far side of the tunnel. With the wildcard
         gone, probe.hproxy.com is reached THROUGH the proxy and can
         answer honestly. The whole exit test depends on it.

         🚨 If the control plane ever moves to a subdomain (api.hproxy.com
         and the like), that exact host must be added here AND in
         testConfig, or healing can no longer reach it through a dead exit. */
      bypassList: ["hproxy.com", "localhost", "127.0.0.1", "[::1]"],
    },
  };
}

function hostPort(p) {
  const h = String(p.host);
  return h.includes(":") ? `[${h}]:${p.port}` : `${h}:${p.port}`;
}
function pacWord(scheme) {
  return scheme === "socks5" ? "SOCKS5" : scheme === "socks4" ? "SOCKS" : "PROXY";
}

/* While a free exit is being tested, ONLY the probe goes through it.
   Everything else stays where it was: on the current exit, or direct when
   nothing is connected yet. A search never sends the person's own pages
   through an exit that has not passed, and New IP keeps them on the working
   exit until the next one has proven itself. `mandatory` means a PAC error
   blocks traffic instead of silently going direct. */
function testConfig(candidate, current) {
  const test = `${pacWord(candidate.scheme)} ${hostPort(candidate)}`;
  const rest = current ? `${pacWord(current.scheme)} ${hostPort(current)}` : "DIRECT";
  const data = [
    "function FindProxyForURL(url, host) {",
    `  if (host === ${JSON.stringify(PROBE_HOST)}) return ${JSON.stringify(test)};`,
    '  if (host === "hproxy.com" || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return "DIRECT";',
    `  return ${JSON.stringify(rest)};`,
    "}",
  ].join("\n");
  return { mode: "pac_script", pacScript: { data, mandatory: true } };
}

function applyProxy(config) {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.set({ value: config, scope: "regular" }, () => {
      const e = chrome.runtime.lastError;
      e ? reject(new Error(e.message)) : resolve();
    });
  });
}
function clearProxy() {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.clear({ scope: "regular" }, () => {
      const e = chrome.runtime.lastError;
      e ? reject(new Error(e.message)) : resolve();
    });
  });
}
/** Put back what the person had before a search: their proxy, or none. */
async function restore(proxy) {
  if (proxy) await applyProxy(proxyConfig(proxy));
  else await clearProxy();
}

function readProxySetting() {
  return new Promise((resolve) => {
    try {
      chrome.proxy.settings.get({}, (d) => {
        if (chrome.runtime.lastError || !d) resolve({ level: "unknown", value: null });
        else resolve({ level: d.levelOfControl, value: d.value });
      });
    } catch {
      resolve({ level: "unknown", value: null });
    }
  });
}

/* Chrome hands the host back normalised: lower case, IPv6 without brackets.
   Compared raw, "Gate.Provider.com" never equals itself and the popup would
   blame another extension for a connection that is fine. */
function sameHost(a, b) {
  const norm = (h) => String(h || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return norm(a) === norm(b);
}

/** Our fixed-server config for exactly this session's proxy is the one Chrome uses. */
function inEffect(setting, session) {
  const p = setting?.value?.rules?.singleProxy;
  return (
    setting?.level === "controlled_by_this_extension" &&
    setting.value.mode === "fixed_servers" &&
    !!p &&
    sameHost(p.host, session.proxy.host) &&
    Number(p.port) === Number(session.proxy.port)
  );
}

/* While connected, WebRTC may only use the proxy, so a page cannot open a
   peer connection around it and learn the real address. Released on
   disconnect: left on, it would keep degrading video calls after the person
   stopped using the proxy, with nothing tying the cause to us. */
function setWebRtcLock(on) {
  return new Promise((resolve) => {
    try {
      const policy = chrome.privacy.network.webRTCIPHandlingPolicy;
      const done = () => {
        void chrome.runtime.lastError;
        resolve();
      };
      if (on) policy.set({ value: "disable_non_proxied_udp" }, done);
      else policy.clear({}, done);
    } catch {
      resolve();
    }
  });
}

const PRODUCT_TITLE = chrome.runtime.getManifest().action?.default_title || "HProxy";
async function setBadge(session, failing) {
  try {
    if (session) {
      await chrome.action.setBadgeText({ text: failing ? "…" : "ON" });
      await chrome.action.setBadgeBackgroundColor({ color: failing ? "#f59e0b" : "#0158ff" });
      await chrome.action.setTitle({ title: `HProxy · ${session.label || "connected"}` });
    } else {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: PRODUCT_TITLE });
    }
  } catch (_) {
    // Badge is cosmetic; never let it break connect/disconnect.
  }
}

// ── The exit test ───────────────────────────────────────────────────────────
/* One request through whatever carries probe.hproxy.com right now. Returns
   the address our server saw it come from and the country Cloudflare places
   that address in ("" when it cannot say), or null. Fails on a certificate
   Chrome does not trust, on a refused tunnel, on a dead or silent proxy, and
   on a Cloudflare block page (a non-2xx), which most sites would show too. */
async function probeExit(timeoutMs = PROBE_TIMEOUT_MS) {
  const ctl = new AbortController();
  probeAbort = ctl;
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const res = await fetch(`${PROBE_URL}?probe=${nonce}`, { cache: "no-store", credentials: "omit", signal: ctl.signal });
    if (!res.ok) return null;
    const body = await res.json();
    const ip = typeof body?.peer_ip === "string" && body.peer_ip ? body.peer_ip : null;
    if (!ip) return null;
    // XX is Cloudflare's "unknown", T1 its Tor exits: neither is a country.
    const cc = String(body?.headers?.["cf-ipcountry"] || "").toUpperCase();
    return { ip, country: /^[A-Z]{2}$/.test(cc) && cc !== "XX" && cc !== "T1" ? cc : "" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (probeAbort === ctl) probeAbort = null;
  }
}
/** The same probe, when only the address matters. */
async function probe(timeoutMs = PROBE_TIMEOUT_MS) {
  return (await probeExit(timeoutMs))?.ip ?? null;
}

// ── The free pool ───────────────────────────────────────────────────────────
async function fetchPool(country, protocol) {
  const qs = new URLSearchParams({ limit: String(POOL_BATCH) });
  if (country) qs.set("country", country);
  if (protocol) qs.set("protocol", protocol);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(`${API}/api/vpn/pool?${qs.toString()}`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`The free pool answered ${res.status}. Try again in a minute.`);
    const data = await res.json();
    return (Array.isArray(data?.proxies) ? data.proxies : [])
      .filter((e) => e && typeof e.ip === "string" && Number(e.port) > 0)
      .map((e) => ({ ip: e.ip, port: Number(e.port), protocols: e.protocols || [], country_code: e.country_code || "" }));
  } finally {
    clearTimeout(timer);
  }
}

/* The batch for one country, kept for a few minutes in session storage so
   New IP and heals walk further down the same list instead of asking again. */
async function poolFor(country, protocol) {
  const key = `${POOL_KEY_PREFIX}${country}:${protocol}`;
  try {
    const cached = (await chrome.storage.session.get(key))?.[key];
    if (cached && Date.now() - cached.at < POOL_TTL_MS && Array.isArray(cached.exits)) return cached.exits;
  } catch {
    /* fetch below */
  }
  const exits = await fetchPool(country, protocol);
  try {
    await chrome.storage.session.set({ [key]: { at: Date.now(), exits } });
  } catch {
    /* works without the cache, just asks more often */
  }
  return exits;
}

async function badExits() {
  try {
    const marks = (await chrome.storage.session.get(BAD_EXITS_KEY))?.[BAD_EXITS_KEY] || {};
    const now = Date.now();
    return new Set(Object.keys(marks).filter((ip) => now - marks[ip] < BAD_EXIT_TTL_MS));
  } catch {
    return new Set();
  }
}
async function markBad(ip) {
  try {
    const marks = (await chrome.storage.session.get(BAD_EXITS_KEY))?.[BAD_EXITS_KEY] || {};
    const now = Date.now();
    for (const k of Object.keys(marks)) if (now - marks[k] >= BAD_EXIT_TTL_MS) delete marks[k];
    marks[ip] = now;
    await chrome.storage.session.set({ [BAD_EXITS_KEY]: marks });
  } catch {
    /* it just gets tested again next time */
  }
}

// chrome.proxy scheme for a pool exit. Free "https" proxies are HTTP proxies
// that support CONNECT (HTTPS tunneling), NOT TLS-terminating proxies, so they
// must use chrome scheme "http", never "https" (which would TLS-handshake the
// proxy itself and fail). Prefer SOCKS5/4, which tunnel everything cleanly.
function schemeForExit(exit, preferred) {
  const protos = (exit.protocols || []).map((p) => String(p).toLowerCase());
  const has = (p) => protos.includes(p);
  if (preferred === "socks5" && has("socks5")) return "socks5";
  if (preferred === "socks4" && has("socks4")) return "socks4";
  if (preferred === "http") return "http";
  if (has("socks5")) return "socks5";
  if (has("socks4")) return "socks4";
  return "http"; // http or https(CONNECT) → HTTP proxy protocol; tunnels HTTPS
}

/* Walk the pool until an exit passes the probe. Only the probe goes through
   each candidate (testConfig). Returns { exit, proxy, seenAs } for the caller
   to commit, or null; either way the caller owns putting a setting back. */
async function findWorkingExit(want, current, skipIps) {
  const exits = await poolFor(want.country || "", want.protocol || "");
  const skip = new Set([...(skipIps || []), ...(await badExits())]);
  if (current) skip.add(String(current.host));
  let tried = 0;
  for (const exit of exits) {
    if (tried >= MAX_EXITS_PER_SEARCH) break;
    if (skip.has(exit.ip)) continue;
    if (stopRequested) throw new Stopped();
    tried += 1;
    const proxy = { scheme: schemeForExit(exit, want.protocol), host: exit.ip, port: exit.port };
    testingHost = proxy.host;
    let seenAs = null;
    try {
      await applyProxy(testConfig(proxy, current));
      seenAs = await probe();
    } finally {
      testingHost = null;
    }
    if (stopRequested) throw new Stopped();
    // Our own address coming back means the request never used the proxy.
    if (seenAs && !(await isOwnAddress(seenAs))) return { exit, proxy, seenAs };
    await markBad(exit.ip);
    reportDead(exit.ip, exit.port, proxy.scheme);
  }
  return null;
}

// Fire-and-forget crowd-sourced health report (feeds the engine's report
// table through the /api/vpn/report gateway).
function reportDead(ip, port, protocol) {
  try {
    fetch(`${API}/api/vpn/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reports: [{ ip, port: Number(port), protocol, alive: false }] }),
      cache: "no-store",
    }).catch(() => {});
  } catch (_) {
    // best-effort only
  }
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();
function noExitMessage(country) {
  let name = country;
  try {
    name = (country && regionNames?.of(country)) || country;
  } catch {
    /* the code will do */
  }
  return country
    ? `No working free exit in ${name} right now. Try another country.`
    : "No working free exit right now. Try again in a minute.";
}

// ── Connect / disconnect core ───────────────────────────────────────────────
// proxy: { scheme, host, port, username?, password? }
// meta:  { mode, label?, exitIp?, country?, vpn?, verified? }
async function connectProxy(proxy, meta) {
  const session = {
    mode: meta.mode, // "vpn" | "pin"
    proxy: {
      scheme: schemeFor(proxy.scheme),
      host: String(proxy.host),
      port: Number(proxy.port),
      username: proxy.username || "",
      password: proxy.password || "",
    },
    label: meta.label || `${proxy.host}:${proxy.port}`,
    exitIp: meta.exitIp || String(proxy.host),
    country: meta.country || "",
    vpn: meta.vpn || null, // { country, protocol, recent:[] } for mode "vpn"
    verified: meta.verified ?? null,
  };
  // Warm the login cache BEFORE the proxy is applied, so the very first
  // request through an authenticated proxy already has it waiting in memory.
  const before = { creds: activeCreds, mode: activeMode };
  remember(session);
  answeredAuth.clear();
  loginRefused = false;
  try {
    await applyProxy(proxyConfig(session.proxy));
  } catch (e) {
    activeCreds = before.creds;
    activeMode = before.mode;
    throw e;
  }
  await saveSession(session);
  await setWebRtcLock(true);
  await setBadge(session, false);
  notifyStatus();
  return describe(session);
}

// Never hand the proxy password back to the popup: identity only.
function publicStatus(session) {
  if (!session) return null;
  return {
    mode: session.mode,
    scheme: session.proxy.scheme,
    host: session.proxy.host,
    port: session.proxy.port,
    label: session.label,
    exitIp: session.exitIp,
    country: session.country,
    auth: !!session.proxy.username,
    /* The last automatic heal found no working exit (mode "vpn"). */
    failing: session.mode === "vpn" && failedHeals > 0,
    /* Mode "pin": whether our probe got an answer through it after connect.
       null = not checked (older session). */
    verified: session.verified ?? null,
    /* The proxy refused the login we sent. Shown as its own state: it looks
       exactly like a dead proxy otherwise, and the fix is the password. */
    loginRefused,
    hijacked: false,
    policy: false,
  };
}

/* The session as the popup shows it, checked against what Chrome actually
   uses. Another extension holding the proxy setting, or a policy, means our
   exit is NOT in effect, whatever the session says. */
async function describe(session) {
  const status = publicStatus(session);
  if (!status) return null;
  const setting = await readProxySetting();
  status.hijacked = setting.level === "controlled_by_other_extensions";
  status.policy = setting.level === "not_controllable";
  status.inEffect = inEffect(setting, session);
  return status;
}

/* The status the popup asks for. The session says connected but our setting
   is not the one in effect (the extension was switched off and on, Chrome
   dropped it): put it back rather than show a Connected that is not true. */
async function currentStatus() {
  const session = await loadSession();
  if (!session) return null;
  const status = await describe(session);
  if (status.inEffect || status.hijacked || status.policy) return status;
  // A search or a test owns the setting right now (its PAC is in effect):
  // that is not a loss, and touching it would spoil the test.
  if (busy || queued > 0) return status;
  /* Put it back through the same queue as every other change, so no search
     can start between reading the setting and writing it. */
  return serial(async () => {
    const again = await loadSession();
    if (!again) return null;
    let fresh = await describe(again);
    if (!fresh.inEffect && !fresh.hijacked && !fresh.policy) {
      try {
        await applyProxy(proxyConfig(again.proxy));
        await setWebRtcLock(true);
      } catch {
        /* reported below */
      }
      fresh = await describe(again);
      if (!fresh.inEffect) fresh.hijacked = true;
    }
    return fresh;
  });
}

function vpnConnect(country, protocol) {
  return serial(async () => {
    stopRequested = false;
    busy = true;
    busyWith = "search";
    failedHeals = 0;
    notifyStatus();
    try {
      const previous = await loadSession();
      // Only while nothing is proxied yet does echo.hproxy.com show OUR
      // address, and the search needs it to spot an exit that is not one.
      if (!previous) await learnRealIps();
      const want = { country: country || "", protocol: protocol || "" };
      const recent =
        previous?.mode === "vpn" && previous.vpn?.country === want.country ? previous.vpn.recent || [] : [];
      let found;
      try {
        found = await findWorkingExit(want, previous?.proxy || null, recent);
      } catch (e) {
        if (!e.stopped) await restore(previous?.proxy || null);
        throw e;
      }
      if (!found) {
        await restore(previous?.proxy || null);
        throw new Error(noExitMessage(want.country));
      }
      return await connectProxy(found.proxy, {
        mode: "vpn",
        label: `${found.exit.country_code || "Free"} · ${found.exit.ip}`,
        exitIp: found.seenAs,
        country: found.exit.country_code || "",
        vpn: { ...want, recent: [found.exit.ip, ...recent.filter((ip) => ip !== found.exit.ip)].slice(0, RECENT_MAX) },
        verified: true,
      });
    } finally {
      busy = false;
      busyWith = null;
    }
  });
}

/* New IP: the next exit that passes, while the person stays on the current
   one. When nothing else passes they keep what they have, and are told. */
function vpnNewIp() {
  return serial(async () => {
    stopRequested = false;
    busy = true;
    busyWith = "search";
    failedHeals = 0;
    notifyStatus();
    try {
      const session = await loadSession();
      if (!session || session.mode !== "vpn" || !session.vpn) return describe(session);
      const recent = session.vpn.recent || [];
      let found;
      try {
        found = await findWorkingExit(session.vpn, session.proxy, recent);
      } catch (e) {
        if (!e.stopped) await restore(session.proxy);
        throw e;
      }
      if (!found) {
        await restore(session.proxy);
        const status = await describe(session);
        status.note = `No other working exit right now. You are still on ${session.exitIp}.`;
        return status;
      }
      return await connectProxy(found.proxy, {
        mode: "vpn",
        label: `${found.exit.country_code || "Free"} · ${found.exit.ip}`,
        exitIp: found.seenAs,
        country: found.exit.country_code || "",
        vpn: { ...session.vpn, recent: [found.exit.ip, ...recent.filter((ip) => ip !== found.exit.ip)].slice(0, RECENT_MAX) },
        verified: true,
      });
    } finally {
      busy = false;
      busyWith = null;
    }
  });
}

function validProxy(p) {
  const host = String(p?.host || "");
  const port = Number(p?.port);
  return host.length > 0 && host.length <= 253 && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/* A proxy of the person's own, tested in THIS browser before anything moves.
   Which protocol it speaks is found here, not on our server: each scheme is
   tried the way a free exit is (testConfig: only the probe goes through it,
   the person's pages stay where they are), with the proxy's own login
   answered from memory. The line and its password never leave the browser,
   and a proxy locked to the person's own address passes, which a test from
   our server never could. The first scheme that brings an answer back wins;
   a refused login stops the test, because every scheme would refuse it too.
   Returns { scheme, exitIp, country }, { scheme, loginRefused: true }, or
   null when nothing answered. */
const PIN_TEST_MS = 6000;
function pinFind(msg) {
  return serial(async () => {
    stopRequested = false;
    busy = true;
    busyWith = "test";
    notifyStatus();
    try {
      if (!validProxy(msg.proxy)) throw new Error("That proxy address is not valid.");
      const previous = await loadSession();
      if (!previous) await learnRealIps();
      const current = previous?.proxy || null;
      const schemes = [...new Set((msg.schemes || []).map(schemeFor))].slice(0, 3);
      const login = msg.proxy.username ? { username: String(msg.proxy.username), password: String(msg.proxy.password || "") } : null;
      let result = null;
      try {
        for (const scheme of schemes) {
          if (stopRequested) throw new Stopped();
          const candidate = { scheme, host: String(msg.proxy.host), port: Number(msg.proxy.port) };
          testingHost = candidate.host;
          testingCreds = login;
          testLoginRefused = false;
          let seen = null;
          try {
            await applyProxy(testConfig(candidate, current));
            seen = await probeExit(PIN_TEST_MS);
          } finally {
            testingHost = null;
            testingCreds = null;
          }
          if (stopRequested) throw new Stopped();
          if (testLoginRefused) {
            result = { scheme, loginRefused: true };
            break;
          }
          /* Any answer counts. The test's PAC script is mandatory, so Chrome
             never falls back to going direct: an answer came through this
             proxy. Unlike a free exit, the person's own proxy may leave from
             their own address (one running on this computer or their
             network); the analyzer says so after connecting. */
          if (seen) {
            result = { scheme, exitIp: seen.ip, country: seen.country };
            break;
          }
        }
      } catch (e) {
        if (!e.stopped) await restore(current);
        throw e;
      }
      await restore(current);
      return result;
    } finally {
      busy = false;
      busyWith = null;
      notifyStatus();
    }
  });
}

function pinConnect(msg) {
  return serial(async () => {
    stopRequested = false;
    busy = true;
    busyWith = "test";
    failedHeals = 0;
    try {
      if (!validProxy(msg.proxy)) throw new Error("That proxy address is not valid.");
      if (!(await loadSession())) await learnRealIps();
      await connectProxy(msg.proxy, { mode: "pin", label: msg.label, exitIp: msg.exitIp, country: msg.country });
      /* Whether anything comes back through it. Not a gate: the person chose
         this proxy and it stays on either way. It decides whether the popup
         says Connected or that nothing answered yet. */
      const seen = await probe(8000);
      const session = await loadSession();
      if (!session) return null;
      session.verified = !!seen;
      await saveSession(session);
      notifyStatus();
      return describe(session);
    } finally {
      busy = false;
      busyWith = null;
    }
  });
}

function disconnect() {
  // Stop a running search at once instead of queueing behind it.
  stopRequested = true;
  probeAbort?.abort();
  clearTimeout(failoverTimer);
  failoverTimer = null;
  return serial(async () => {
    stopRequested = false;
    failedHeals = 0;
    remember(null);
    answeredAuth.clear();
    loginRefused = false;
    try {
      await clearProxy();
    } finally {
      await setWebRtcLock(false);
      await saveSession(null);
      await setBadge(null, false);
      notifyStatus();
    }
  });
}

// ── Healing a free exit that dies mid-browse (mode "vpn" only) ──────────────
function scheduleHeal() {
  if (busy || failedHeals >= MAX_FAILED_HEALS) return;
  clearTimeout(failoverTimer);
  failoverTimer = setTimeout(() => {
    failoverTimer = null;
    heal().catch(() => {});
  }, FAILOVER_DEBOUNCE_MS);
}

function heal() {
  return serial(async () => {
    if (stopRequested || failedHeals >= MAX_FAILED_HEALS) return;
    busy = true;
    busyWith = "search";
    try {
      const session = await loadSession();
      if (!session || session.mode !== "vpn" || !session.vpn) return;
      // One refused site, one broken certificate, one slow page: not a dead
      // exit. Ask the exit itself before throwing it away.
      if (await probe()) {
        if (failedHeals) {
          failedHeals = 0;
          await setBadge(session, false);
          notifyStatus();
        }
        return;
      }
      const recent = session.vpn.recent || [];
      let found;
      try {
        found = await findWorkingExit(session.vpn, session.proxy, recent);
      } catch (e) {
        if (!e.stopped) await restore(session.proxy);
        throw e;
      }
      if (!found) {
        failedHeals += 1;
        // Stay on the dead exit rather than fall back to the real address
        // without asking: pages fail until the person picks another country,
        // presses New IP or disconnects. The amber badge says so.
        await restore(session.proxy);
        await setBadge(session, true);
        notifyStatus();
        return;
      }
      failedHeals = 0;
      reportDead(session.proxy.host, session.proxy.port, session.proxy.scheme);
      await connectProxy(found.proxy, {
        mode: "vpn",
        label: `${found.exit.country_code || "Free"} · ${found.exit.ip}`,
        exitIp: found.seenAs,
        country: found.exit.country_code || "",
        vpn: { ...session.vpn, recent: [found.exit.ip, ...recent.filter((ip) => ip !== found.exit.ip)].slice(0, RECENT_MAX) },
        verified: true,
      });
    } finally {
      busy = false;
      busyWith = null;
    }
  });
}

/* What a dying exit looks like from a page. Certificate errors are in the
   list because an exit that starts re-signing HTTPS shows up as nothing
   else; a site whose own certificate is broken lands here too, and the probe
   in heal() tells the two apart. */
const EXIT_TROUBLE = /ERR_PROXY|ERR_TUNNEL|ERR_SOCKS|ERR_CERT_|ERR_SSL_PROTOCOL_ERROR/;

/* The only request listener besides the login one. There is deliberately no
   onCompleted listener: it woke this worker for every successful request in
   the whole browser, connected or not, only to reset a counter that the
   probe in heal() now resets from a real measurement. */
chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    answeredAuth.delete(d.requestId);
    if (busy || !EXIT_TROUBLE.test(d.error || "")) return;
    // Our own probes and API calls report on themselves.
    if (d.initiator === OWN_ORIGIN) return;
    hydrate().then(() => {
      if (activeMode === "vpn") scheduleHeal();
    });
  },
  { urls: ["<all_urls>"] },
);

// ── Proxy authentication ────────────────────────────────────────────────────
// Registered at TOP LEVEL so it is live whenever the worker is (survives MV3
// recycling). A website's own 401 never gets the proxy password: only proxy
// (407) challenges are answered.
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) {
      callback({});
      return;
    }
    /* A proxy under test. A free exit that wants a login is not a free exit.
       A proxy of the person's own (pinFind) gets its own login, once: asked
       again for the same request, it refused it. Hosts compared normalised,
       because Chrome hands them back in lower case. */
    if (testingHost && sameHost(details.challenger?.host, testingHost)) {
      if (testingCreds && !answeredAuth.has(details.requestId)) {
        answeredAuth.add(details.requestId);
        callback({ authCredentials: testingCreds });
      } else {
        if (testingCreds) testLoginRefused = true;
        answeredAuth.delete(details.requestId);
        callback({ cancel: true });
      }
      return;
    }
    // The login was refused already: never send it again until they reconnect.
    if (loginRefused) {
      callback({ cancel: true });
      return;
    }
    // Asked twice for the same request: the proxy refused what we sent.
    if (answeredAuth.has(details.requestId)) {
      answeredAuth.delete(details.requestId);
      loginRefused = true;
      loadSession().then((s) => setBadge(s, true));
      notifyStatus();
      callback({ cancel: true });
      return;
    }
    const answer = () => {
      if (activeCreds) {
        if (answeredAuth.size > 500) answeredAuth.clear();
        answeredAuth.add(details.requestId);
        callback({ authCredentials: activeCreds });
      } else if (activeMode === "vpn") {
        // A free exit that started asking for a login: move on, never a
        // login box for a password nobody has.
        callback({ cancel: true });
        scheduleHeal();
      } else {
        // Their own proxy with no login saved: Chrome asks them.
        callback({});
      }
    };
    // Warm path: answered synchronously. Cold path (worker just woke): every
    // queued challenge shares ONE storage read.
    if (hydrated) answer();
    else hydrate().then(answer, () => callback({}));
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"],
);

// ── Message router (popup → worker) ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "status":
          sendResponse({
            ok: true,
            active: await currentStatus(),
            searching: busyWith === "search",
            testing: busyWith === "test",
          });
          break;
        case "vpnConnect":
          sendResponse({ ok: true, active: await vpnConnect(msg.country || "", msg.protocol || "") });
          break;
        case "vpnNewIp":
          sendResponse({ ok: true, active: await vpnNewIp() });
          break;
        case "pinFind":
          sendResponse({ ok: true, found: await pinFind(msg) });
          break;
        case "pinConnect":
          sendResponse({ ok: true, active: await pinConnect(msg) });
          break;
        case "disconnect":
          await disconnect();
          sendResponse({ ok: true, active: null });
          break;
        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.stopped ? "Stopped." : e?.message || String(e) });
    }
  })();
  return true; // async response
});

// ── Every start of the worker: Chrome's setting and the session agree ───────
/* A session whose setting is gone gets it back (the extension was switched
   off and on); a setting of ours with no session is removed (a search that
   was cut off mid-way). Runs through `serial`, so it is done before any
   message the start was woken for. */
serial(async () => {
  const session = await loadSession();
  remember(session);
  const setting = await readProxySetting();
  const ours = setting.level === "controlled_by_this_extension";
  const free = setting.level === "controllable_by_this_extension";
  if (session && (ours || free) && !inEffect(setting, session)) {
    try {
      await applyProxy(proxyConfig(session.proxy));
      await setWebRtcLock(true);
    } catch {
      /* the popup reports it */
    }
  }
  if (!session && ours) {
    try {
      await clearProxy();
    } catch {
      /* nothing else to do */
    }
  }
  if (!session) await setWebRtcLock(false);
}).catch(() => {});

// The badge is not kept across browser restarts; the setting and the session are.
chrome.runtime.onStartup.addListener(async () => {
  setBadge(await loadSession(), false);
});
chrome.runtime.onInstalled.addListener(async () => {
  setBadge(await loadSession(), false);
});
