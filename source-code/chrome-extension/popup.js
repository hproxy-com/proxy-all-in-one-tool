/* ============================================================
   HProxy popup — TWO SURFACES.

   The brief (2026-08-02): a proxy connector and a proxy analyzer at
   once, and a second surface for the free rotating exits.

   Split by what you came to do, not by screen size:

     Proxies   connect your own proxy or an HProxy plan, and see
               immediately what it is actually doing. Connecting and
               analyzing are one motion.
     Free      free rotating exits by country. One tap, no decisions.
               (Its code still says "vpn": the surface's id, not a word
               anyone reads.)

   Proxies opens first by default, because that is what most people are
   here for. Settings can flip it, and the popup remembers where you
   were unless you pin one.

   ── ONE POPUP, THE APP'S LOOK ───────────────────────────────────────
   popup.html is the desktop app's Connect card made for the toolbar
   (2026-09-24): the state in words, the switch, and the route from this
   browser through the H to the exit, with the H itself a button. Under
   it, the two places to connect to. (Until then three design versions
   shared this file; the look that replaced them is the app's.)

   Every element lookup still goes through `el()`, which returns null for
   anything the markup does not render, and every write checks first, so
   the markup can change without forking the logic.

   State lives in the background worker (background.js). This file is a
   remote control that reads and commands, and owns no session truth.
   ============================================================ */

import { analyze } from "./analyzer.js";
import { parseLine } from "./line.js";

const API = "https://hproxy.com";

/* "Your HProxy plans" needs "Sign in with HProxy", whose server route is not
   live yet (the sign-in page answers 404). Until it is, the block stays
   hidden and nothing asks for a sign-in. Switching it on is this line plus
   "identity" back in manifest.json's permissions (the sign-in window is
   chrome.identity.launchWebAuthFlow); the store refuses a permission that
   nothing uses, so it is out while this is false. */
const PLANS_LIVE = false;

/* ── element access, skin-tolerant ──────────────────────────────────── */

const cache = new Map();
function el(id) {
  if (!cache.has(id)) cache.set(id, document.getElementById(id));
  return cache.get(id);
}
/** Write text only if this skin rendered the element. */
function text(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}
/** Show or hide only if this skin rendered the element. */
function show(id, visible) {
  const node = el(id);
  if (node) node.hidden = !visible;
}
function on(id, event, handler) {
  el(id)?.addEventListener(event, handler);
}

/* ── state ──────────────────────────────────────────────────────────── */

let countries = [];
let favCountries = [];
let countryFilter = "";
let connectingCC = null;
let active = null;
/* The worker is testing an exit or a proxy right now (from the last status). */
let busyNow = false;
/* Where the switch and the H go when pressed: the last place connected to. */
let lastTarget = null;
let phaseNow = "off";
let surface = "proxies";
let settings = { firstSurface: "proxies", pinSurface: false };
let analyzing = false;
let lastRows = [];

/* ── storage ────────────────────────────────────────────────────────── */

const store = {
  get: (area, key, fallback) =>
    new Promise((r) => chrome.storage[area].get(key, (o) => r(o?.[key] ?? fallback))),
  set: (area, key, value) => new Promise((r) => chrome.storage[area].set({ [key]: value }, r)),
};

function send(msg) {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage(msg, res);
    } catch {
      res(null);
    }
  });
}

/* ── formatting ─────────────────────────────────────────────────────── */

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();
function ccName(cc) {
  try {
    return (cc && regionNames?.of(String(cc).toUpperCase())) || cc || "";
  } catch {
    return cc || "";
  }
}
/* PNGs made from flags/*.svg by scripts/rasterize-flags.mjs: 2.0 MB of SVG
   became a few hundred bytes a flag, decoded off the main thread. */
function flagImg(cc) {
  return /^[A-Za-z]{2}$/.test(cc || "")
    ? `<img class="flag" src="flags/${String(cc).toLowerCase()}.png" alt="" decoding="async">`
    : `<span class="flag--none"></span>`;
}
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/* ── the connection card ────────────────────────────────────────────── */

/** Write text and, when it changed, replay the element's fade-up. */
function textFresh(id, value) {
  const node = el(id);
  if (!node || node.textContent === value) return;
  node.textContent = value;
  node.classList.remove("is-new");
  void node.offsetWidth; // restart the animation
  node.classList.add("is-new");
}

const GLOBE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>`;
const BOLT_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" /></svg>`;

/** The route's far end: where traffic comes out, or where the H will go. */
function setExit(cc, name, icon) {
  const flag = el("routeFlag");
  if (flag) flag.innerHTML = cc ? flagImg(cc) : icon || "";
  text("routeName", name);
  const exit = el("routeExit");
  if (exit) exit.title = name;
}

/* The blue card spreads from the H's middle, wherever the layout put it. */
function measureHub() {
  const card = el("status");
  const h = el("hbutton");
  if (!card || !h) return;
  const c = card.getBoundingClientRect();
  const b = h.getBoundingClientRect();
  card.style.setProperty("--hub-x", `${Math.round(b.left + b.width / 2 - c.left)}px`);
  card.style.setProperty("--hub-y", `${Math.round(b.top + b.height / 2 - c.top)}px`);
}

/* The place the switch and the H connect to: kept after every connect. */
const LAST_KEY = "hproxy_last_target";
async function rememberTarget(target) {
  lastTarget = target;
  await store.set("local", LAST_KEY, target);
}

/* The switch and the H do the same thing. Connected, or still connecting:
   back to your own address. Otherwise: the last place used, or the fastest
   free exit when there is none yet. */
async function toggleConnection() {
  if (active || busyNow) return doDisconnect();
  if (lastTarget?.kind === "vpn" && lastTarget.country) return connectCountry(lastTarget.country);
  if (lastTarget?.kind === "pin") {
    const saved = (await store.get("local", "hproxy_byo", [])).find((x) => `${x.host}:${x.port}` === lastTarget.key);
    if (saved) return connectSaved(saved);
  }
  return quickConnect();
}

/* ── status ─────────────────────────────────────────────────────────── */

async function refreshStatus({ rerunAnalysis = false } = {}) {
  const was = active?.exitIp;
  const res = await send({ type: "status" });
  active = res?.active || null;
  /* The worker is testing free exits right now (Quick Connect, New IP, or a
     heal). Nothing has moved yet: pages stay where they were until one passes. */
  const searching = !!res?.searching;
  /* A proxy of their own is being tried once, right after connecting. */
  const testing = !!res?.testing;

  const on_ = !!active;
  const failing = !!active?.failing;
  /* Another extension holds Chrome's proxy, so our exit is NOT in effect. This
     is a warning state, not a healthy connection: show it as such even though a
     session exists, so we never display a green "Connected" over traffic that is
     not going through us. (Teardown: ~20 rivals detect this, we did not.) */
  const hijacked = !!active?.hijacked;
  /* A policy (a company-managed browser) sets the proxy: nobody can change it. */
  const policy = !!active?.policy;
  const refused = !!active?.loginRefused;
  /* Their own proxy, and nothing came back through it right after connecting. */
  const silent = on_ && active.mode === "pin" && active.verified === false;
  const warn = on_ && (failing || hijacked || policy || refused || silent);
  busyNow = searching || testing;

  /* The card's phase, as the app names them: the look hangs on it. */
  const phase = on_ ? (searching ? "rotating" : "on") : busyNow ? "connecting" : "off";
  const conn = el("conn");
  if (conn) {
    conn.dataset.phase = phase;
    conn.toggleAttribute("data-failing", warn);
  }
  const lit = on_ || busyNow;
  const title = lit ? "Disconnect" : "Connect";
  const sw = el("connSwitch");
  if (sw) {
    sw.classList.toggle("is-on", lit);
    sw.classList.toggle("is-busy", busyNow);
    sw.setAttribute("aria-checked", String(lit));
    sw.title = title;
  }
  const h = el("hbutton");
  if (h) {
    h.setAttribute("aria-pressed", String(lit));
    h.title = title;
  }

  /* The headline says where you appear; the far end of the route says where
     traffic comes out, or where the switch will take it. */
  if (on_) {
    const cc = active.country ? String(active.country).toUpperCase() : "";
    const where = cc ? ccName(cc) : active.mode === "pin" ? `${active.host}:${active.port}` : active.exitIp || active.host;
    textFresh("statusHead", where);
    setExit(cc, cc ? ccName(cc) : active.host, GLOBE_SVG);
    text("footState", warn ? "Disconnect to go back to your own address." : "All of Chrome goes through it.");
  } else if (busyNow) {
    textFresh("statusHead", searching ? "Finding a free exit" : "Testing your proxy");
    text("footState", searching ? "Testing free exits. Your pages stay where they are until one passes." : "Only the test goes through it until it answers.");
  } else {
    textFresh("statusHead", "Your own address");
    if (lastTarget?.kind === "vpn" && lastTarget.country) setExit(lastTarget.country, ccName(lastTarget.country));
    else if (lastTarget?.kind === "pin") setExit("", lastTarget.key, GLOBE_SVG);
    else setExit("", "Fastest free exit", BOLT_SVG);
    text("footState", "Nothing in this browser changes until you connect.");
  }
  if (phase === "on" && phaseNow !== "on") {
    const flag = el("routeFlag");
    flag?.classList.remove("arrived");
    void flag?.offsetWidth;
    flag?.classList.add("arrived");
  }
  phaseNow = phase;
  measureHub();

  if (on_ && policy) {
    text("statusTitle", "Your organisation sets the proxy");
    text("statusSub", "A policy controls this browser's proxy, so no extension can change it.");
    show("disconnectBtn", true);
    show("newIpBtn", false);
  } else if (on_ && hijacked) {
    text("statusTitle", "Another extension is in control");
    text("statusSub", "Disable your other proxy or VPN extension, then reconnect.");
    show("disconnectBtn", true);
    show("newIpBtn", false);
  } else if (on_ && refused) {
    /* Reads exactly like a dead proxy otherwise, and the fix is the password. */
    text("statusTitle", "The proxy refused the login");
    text("statusSub", "Check the username and password for this proxy.");
    show("disconnectBtn", true);
    show("newIpBtn", false);
  } else if (silent) {
    text("statusTitle", "Connected, no answer yet");
    text("statusSub", "Nothing came back through this proxy. Check the address and the login.");
    show("disconnectBtn", true);
    show("newIpBtn", false);
  } else if (on_) {
    text("statusTitle", failing ? "This exit stopped working" : "Connected");
    textFresh(
      "statusSub",
      searching
        ? "Finding a working exit"
        : testing
          ? "Testing the connection"
          : failing
            ? "Try New IP, another country, or Disconnect."
            : `${active.exitIp || active.host} · ${active.mode === "vpn" ? "free exit" : "your proxy"}`,
    );
    show("disconnectBtn", true);
    show("newIpBtn", active.mode === "vpn");
  } else if (busyNow) {
    text("statusTitle", "Connecting");
    textFresh("statusSub", searching ? "The best free exit, tested first" : "Finding out which protocol it speaks");
    show("disconnectBtn", true);
    show("newIpBtn", false);
  } else {
    text("statusTitle", "Not connected");
    textFresh("statusSub", "Sites see where you really are");
    show("disconnectBtn", false);
    show("newIpBtn", false);
  }

  const vpnOn = on_ && active.mode === "vpn";
  el("quickBtn")?.classList.toggle("is-connected", vpnOn && !failing && !searching);
  el("quickBtn")?.classList.toggle("is-busy", searching);
  text("quickMain", vpnOn ? "Disconnect" : searching ? "Connecting" : "Quick Connect");
  text(
    "quickSub",
    searching
      ? "Finding a working exit"
      : vpnOn
        ? failing
          ? "This exit stopped working"
          : `Connected · ${active.country ? ccName(active.country) : active.exitIp}`
        : "The best free exit, tested first",
  );

  markCountryStates();

  /* Re-analyze when the exit actually changed, not on every poll. The
     status poll runs every 2.5s and the analysis makes network calls. */
  if (rerunAnalysis || was !== active?.exitIp) runAnalysis();
}

/* ── the analyzer ───────────────────────────────────────────────────── */

const STATUS_WORD = { ok: "Clear", warn: "Check", bad: "Leaking", unknown: "Unknown", skip: "Idle" };

async function runAnalysis() {
  const list = el("analyzeList");
  if (!list || analyzing) return;
  analyzing = true;

  el("analyze")?.setAttribute("data-state", "running");
  setVerdict({ status: "unknown", headline: "Checking", detail: "Running the connection checks." });

  /* Rows are painted as they arrive rather than at the end. Two checks
     make network calls and one does not; making the six fast answers
     wait for the slowest is the difference between "instant" and "laggy"
     for the exact same total work. */
  const seen = new Map();
  const paint = () => {
    /* Skipped rows are not rendered. With nothing connected that is six
       lines all saying "Not connected", which is a wall of text restating
       the one line above it. The verdict says it once. */
    const rows = [...seen.values()]
      .filter((r) => r.status !== "skip")
      .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    list.textContent = "";
    for (const row of rows) list.appendChild(analyzeRow(row));
  };

  try {
    const { verdict, rows } = await analyze(active, (row) => {
      seen.set(row.id, row);
      paint();
    });
    lastRows = rows;
    setVerdict(verdict);
  } catch (e) {
    setVerdict({ status: "unknown", headline: "The check did not finish", detail: e?.message || String(e) });
  } finally {
    // Always released: a stuck flag would silently end every later check.
    el("analyze")?.setAttribute("data-state", "done");
    analyzing = false;
  }
}

/* Reading order, fixed. The analyzer sorts by severity for its verdict,
   but the LIST stays in a stable order so the rows do not jump around
   between runs and make the panel feel unreliable. */
const ORDER = ["exit", "transparency", "dns", "webrtc", "timezone", "locale", "latency"];

function setVerdict(v) {
  const node = el("verdict");
  if (!node) return;
  node.dataset.status = v.status;
  text("verdictHead", v.headline);
  text("verdictSub", v.detail || "");
}

function analyzeRow(row) {
  const node = document.createElement("div");
  node.className = "arow";
  node.dataset.status = row.status;
  const state = STATUS_WORD[row.status] || "";

  /* ⚠️ Label, detail, value and state are DIRECT children on purpose.
     They were wrapped in an .arow-main span at first, and `grid-area`
     only applies to direct grid children, so the wrapper swallowed both
     and the label ran straight into the detail on one line.

     The state word is rendered only when there is something to act on.
     "CLEAR" repeated down a column of healthy rows is noise, and noise
     is how a security panel teaches people to stop reading it. The dot
     still carries the status for everyone, because it is labelled. */
  node.innerHTML =
    `<span class="arow-dot" role="img" aria-label="${escapeHtml(state)}"></span>` +
    `<span class="arow-label">${escapeHtml(row.label)}</span>` +
    `<span class="arow-value">${escapeHtml(row.headline || "")}</span>` +
    `<span class="arow-detail" title="${escapeHtml(row.detail || "")}">${escapeHtml(row.detail || "")}</span>` +
    (row.status === "ok" || row.status === "skip"
      ? ""
      : `<span class="arow-state">${escapeHtml(state)}</span>`);

  /* A finding the user cannot act on is a complaint. When a check knows
     how to fix itself, the row carries the button. */
  if (row.fix) {
    const btn = document.createElement("button");
    btn.className = "btn btn--ghost btn--sm arow-fix";
    btn.textContent = row.fix.label;
    btn.addEventListener("click", () => applyFix(row.fix.id, btn));
    node.appendChild(btn);
  }
  return node;
}

async function applyFix(id, btn) {
  btn.disabled = true;
  btn.textContent = "Applying";
  if (id === "lock-webrtc") {
    await new Promise((r) =>
      chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: "disable_non_proxied_udp" }, r),
    );
  }
  await runAnalysis();
}

/* ── surfaces ───────────────────────────────────────────────────────── */

function setSurface(next) {
  surface = next;
  document.querySelectorAll("[data-surface]").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.surface === next);
  });
  show("surface-proxies", next === "proxies");
  show("surface-vpn", next === "vpn");
  if (!settings.pinSurface) store.set("local", "hproxy_last_surface", next);
}

/* ── VPN: countries ─────────────────────────────────────────────────── */

/* The list is shown from the last answer at once (kept for this browser
   session), then refreshed. It used to wait for the network on every open,
   AFTER the connection checks had finished: measured 2026-09-23, about 0.9 s
   before the VPN tab showed a single country. */
const COUNTRIES_KEY = "hproxy_countries";
async function loadCountries() {
  if (!countries.length) {
    try {
      const kept = (await chrome.storage.session.get(COUNTRIES_KEY))?.[COUNTRIES_KEY];
      if (Array.isArray(kept) && kept.length) {
        countries = kept;
        renderFavs();
        renderCountries();
      }
    } catch {
      /* first open of the session: the network answers below */
    }
  }
  try {
    const res = await fetch(`${API}/api/vpn/countries`, { headers: { Accept: "application/json" } });
    const data = await res.json();
    const fresh = (Array.isArray(data?.countries) ? data.countries : []).filter((c) =>
      /^[A-Za-z]{2}$/.test(c.country_code || ""),
    );
    if (fresh.length || !countries.length) countries = fresh;
    chrome.storage.session.set({ [COUNTRIES_KEY]: countries }).catch(() => {});
  } catch {
    // Offline or refused: keep what is on screen rather than blank it.
  }
  renderFavs();
  renderCountries();
}

function renderCountries() {
  const list = el("countryList");
  if (!list) return;
  const q = countryFilter.trim().toLowerCase();
  text("footNote", countries.length ? `${countries.length} countries` : "");
  list.textContent = "";
  if (!countries.length) {
    list.innerHTML = `<p class="hint">No locations available right now. Hit Refresh.</p>`;
    return;
  }
  const matches = countries.filter(
    (c) =>
      !q ||
      ccName(c.country_code).toLowerCase().includes(q) ||
      c.country_code.toLowerCase().includes(q),
  );
  if (!matches.length) {
    list.innerHTML = `<p class="hint">No country matches "${escapeHtml(countryFilter)}".</p>`;
    return;
  }
  const favSet = new Set(favCountries.map((c) => c.toUpperCase()));
  matches.forEach((c, i) => {
    const cc = c.country_code.toUpperCase();
    list.appendChild(countryRow(cc, c.count, favSet.has(cc), i));
  });
  markCountryStates();
}

/* The count is free IPs in that country, not places: "2497 locations" for
   the United States promised cities that do not exist. */
function ipCount(count) {
  const n = Math.max(0, Number(count) || 0);
  return `${n.toLocaleString("en-US")} IP${n === 1 ? "" : "s"}`;
}

function countryRow(cc, count, faved, index) {
  const row = document.createElement("div");
  row.className = "crow";
  row.dataset.cc = cc;
  row.style.setProperty("--i", index % 16);
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.innerHTML =
    `${flagImg(cc)}` +
    `<span class="crow-main">` +
    `<span class="crow-name">${escapeHtml(ccName(cc))}</span>` +
    `<span class="crow-meta">${ipCount(count)}</span>` +
    `</span>` +
    `<span class="crow-star star${faved ? " on" : ""}" title="Favorite">${faved ? "★" : "☆"}</span>` +
    `<span class="crow-go" aria-hidden="true">→</span>`;
  row.addEventListener("click", () => connectCountry(cc));
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      connectCountry(cc);
    }
  });
  row.querySelector(".crow-star").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavCountry(cc);
  });
  return row;
}

function markCountryStates() {
  const activeCC =
    active && active.mode === "vpn" && active.country ? String(active.country).toUpperCase() : null;
  document.querySelectorAll(".crow[data-cc]").forEach((row) => {
    const cc = row.dataset.cc;
    const isActive = activeCC && cc === activeCC && !active.failing;
    const isConnecting = connectingCC === cc || (active && active.failing && cc === activeCC);
    row.classList.toggle("crow--active", !!isActive);
    row.classList.toggle("crow--connecting", !!isConnecting);
    const go = row.querySelector(".crow-go");
    if (go) go.innerHTML = isConnecting ? `<span class="spin"></span>` : isActive ? "✓" : "→";
  });
}

async function connectCountry(cc) {
  cc = cc.toUpperCase();
  if (active?.mode === "vpn" && String(active.country).toUpperCase() === cc && !active.failing) {
    await doDisconnect();
    return;
  }
  connectingCC = cc;
  markCountryStates();
  const r = await send({ type: "vpnConnect", country: cc, protocol: "" });
  connectingCC = null;
  if (r?.ok) await rememberTarget({ kind: "vpn", country: cc });
  await refreshStatus({ rerunAnalysis: true });
  if (r && r.ok === false) {
    const go = document.querySelector(`.crow[data-cc="${cc}"] .crow-go`);
    if (go) go.textContent = "✕";
    text("quickSub", r.error || "Could not connect. Try again.");
  }
}

async function toggleFavCountry(cc) {
  cc = cc.toUpperCase();
  const has = favCountries.map((c) => c.toUpperCase()).includes(cc);
  favCountries = has
    ? favCountries.filter((c) => c.toUpperCase() !== cc)
    : [cc, ...favCountries].slice(0, 20);
  await store.set("sync", "hproxy_fav_countries", favCountries);
  renderFavs();
  renderCountries();
}

function renderFavs() {
  const list = el("favList");
  show("favHead", favCountries.length > 0);
  if (!list) return;
  list.textContent = "";
  if (!favCountries.length) return;
  const counts = new Map(countries.map((c) => [c.country_code.toUpperCase(), c.count]));
  favCountries.forEach((cc, i) => {
    cc = cc.toUpperCase();
    list.appendChild(countryRow(cc, counts.get(cc) ?? 0, true, i));
  });
  markCountryStates();
}

/* ── connect actions ────────────────────────────────────────────────── */

async function quickConnect() {
  if (active?.mode === "vpn") {
    await doDisconnect();
    return;
  }
  el("quickBtn")?.classList.add("is-busy");
  text("quickMain", "Connecting");
  text("quickSub", "Finding a working exit");
  const r = await send({ type: "vpnConnect", country: "", protocol: "" });
  el("quickBtn")?.classList.remove("is-busy");
  if (r?.ok) await rememberTarget({ kind: "vpn", country: "" });
  await refreshStatus({ rerunAnalysis: true });
  // After the refresh, or the refresh would overwrite the reason.
  if (r && r.ok === false) text("quickSub", r.error || "Could not connect. Try again.");
}

async function newIp() {
  const btn = el("newIpBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Finding";
  }
  const r = await send({ type: "vpnNewIp" });
  if (btn) {
    btn.disabled = false;
    btn.textContent = "New IP";
  }
  await refreshStatus({ rerunAnalysis: true });
  // "Nothing else passed, you are still on X" is an answer, not a failure.
  if (r?.active?.note) text("statusSub", r.active.note);
  else if (r && r.ok === false) text("statusSub", r.error || "Could not change the exit.");
}

async function doDisconnect() {
  await send({ type: "disconnect" });
  await refreshStatus({ rerunAnalysis: true });
}

/* ── Proxies: bring your own ──────────────────────────────────────────
   ONE input, ONE button.

   The earlier design had three big buttons (Connect, Test, Save) and a
   protocol picker (http, https, socks5, socks). Both asked the person for
   something the extension can work out by itself.

   ── Which protocol it speaks is found in THIS browser ──
   The worker tries the proxy the way it tries a free exit: only its probe
   goes through the proxy, the person's pages stay where they are, and the
   first protocol that brings an answer back is the one used (background.js,
   pinFind). The line and its password never leave the browser. (Until
   version 1.0 the line, login included, went to our server's checker to
   learn its protocols, and a proxy locked to the person's own address failed
   that check while working fine here.)

   A picker also had one option that was always WRONG: a proxy advertised
   as "https" is an HTTP proxy that supports CONNECT, not a TLS-terminating
   one, so Chrome must be given the scheme "http". Picking HTTPS made Chrome
   TLS-handshake the proxy itself and fail.

   ── Why Test and Save are gone ──
   Connecting IS the test: the analyzer below runs on every connect and
   says more than a one-line "Alive" ever did. And a proxy you just
   connected to is one you want kept, so saving is a consequence, not a
   decision to make first.

   ── Nothing answering never blocks a connect ──
   A proxy may refuse only our probe's address and carry everything else.
   So when no protocol answered, it still connects with the best guess and
   the status says that nothing came back yet. Only a refused login stops
   it: every protocol would refuse the same login. */

/* The line is read by the engine's own parser (line.js), so every shape the
   desktop app and the website accept works here too: user:pass@host:port,
   socks5://..., login first, CSV, IPv6. It used to be split on ":" and
   refused all of those. */
function parseByo(str) {
  return parseLine(str);
}

/* The protocols to try, in order.

   ⚠️ Chrome CANNOT send a username/password to a SOCKS proxy: chrome.proxy has
   no way to carry SOCKS auth, and onAuthRequired never fires for SOCKS. So a
   proxy line that carries credentials goes over HTTP first; SOCKS5 is tried
   after it only for a proxy locked to the person's IP, which ignores the
   login. Without a login SOCKS5 goes first, as it carries everything
   cleanly. The protocol the line itself names (socks5://...) is tried
   before all of them: a socks5:// port usually speaks nothing else. */
function schemesToTry(hint, hasAuth) {
  const order = hasAuth ? ["http", "socks5"] : ["socks5", "http", "socks4"];
  return [...new Set([hint, ...order].filter(Boolean))].slice(0, 3);
}

function byoMsg(message, kind) {
  const node = el("byoMsg");
  if (!node) return;
  node.hidden = false;
  node.className = `msg ${kind || "info"}`;
  node.textContent = message;
}

async function byoConnectNow() {
  const parsed = parseByo(el("byoInput")?.value);
  if (parsed.error) return byoMsg(`${parsed.error}`, "bad");

  const btn = el("byoConnect");
  const done = () => {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Connect";
    }
  };
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Testing";
  }
  byoMsg("Testing it in this browser. Your pages stay where they are until it answers.", "info");

  const hasAuth = !!parsed.username;
  const tried = schemesToTry(parsed.scheme, hasAuth);
  const test = await send({
    type: "pinFind",
    proxy: { host: parsed.host, port: parsed.port, username: parsed.username, password: parsed.password },
    schemes: tried,
  });
  if (test && !test.ok) {
    done();
    return byoMsg(`Could not test it: ${test.error || "the extension did not answer"}`, "bad");
  }
  const found = test?.found || null;
  if (found?.loginRefused) {
    done();
    return byoMsg("The proxy refused the login. Check the username and password. Nothing was changed.", "bad");
  }

  const proxy = {
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    password: parsed.password,
    scheme: found?.scheme || tried[0],
  };
  /* An authenticated proxy that only speaks SOCKS cannot work in Chrome (no way
     to send SOCKS credentials). Say so plainly instead of letting it fail with a
     confusing tunnel error. We still attempt the connect: an IP-whitelisted SOCKS
     proxy ignores the creds and works, so this is a heads-up, not a refusal. */
  const socksWithLogin = hasAuth && proxy.scheme.startsWith("socks");
  const socksNote = socksWithLogin
    ? " Chrome cannot send a SOCKS login, so this only works if the proxy is locked to your IP instead."
    : "";
  byoMsg(
    found
      ? `It answered over ${proxy.scheme.toUpperCase()}. Connecting.${socksNote}`
      : `Nothing answered the test. Connecting over ${proxy.scheme.toUpperCase()} anyway, in case it only refused our test address.${socksNote}`,
    "info",
  );
  const r = await send({
    type: "pinConnect",
    proxy,
    label: `${proxy.host}:${proxy.port}`,
    exitIp: found?.exitIp || proxy.host,
    country: found?.country || "",
  });
  done();

  if (!r?.ok) {
    byoMsg(`Could not connect: ${r?.error || "no route to that proxy"}`, "bad");
    return;
  }

  /* A proxy that works is one you want kept: saving is a consequence of
     connecting, never a second decision. One that refused the login or
     answered nothing is not saved: it would only sit in the list looking
     usable. */
  const how = proxy.scheme.toUpperCase();
  const refused = !!r.active?.loginRefused;
  const answered = r.active?.verified !== false;
  if (!refused && answered) {
    await saveByo({ ...proxy, country: found?.country || "" });
    await rememberTarget({ kind: "pin", key: `${proxy.host}:${proxy.port}` });
  }
  const where = found?.country ? ` · ${ccName(found.country)}` : "";
  if (refused) byoMsg("The proxy refused the login. Check the username and password. Not saved.", "bad");
  else if (!answered) byoMsg(`Connected over ${how}, but nothing came back through it.${socksNote} Check the address and the login. Not saved.`, "bad");
  else byoMsg(`Connected over ${how}${where}. Saved.`, "ok");
  await refreshStatus({ rerunAnalysis: true });
  renderByoList();
}

/** Store a proxy in the saved list, newest first, no duplicates. */
async function saveByo(proxy) {
  const list = await store.get("local", "hproxy_byo", []);
  const key = `${proxy.host}:${proxy.port}`;
  const next = [{ ...proxy, label: key }, ...list.filter((x) => `${x.host}:${x.port}` !== key)].slice(0, 50);
  await store.set("local", "hproxy_byo", next);
}

/** Connect to a saved proxy, and make it the place the switch goes back to. */
async function connectSaved(x) {
  const r = await send({
    type: "pinConnect",
    proxy: { scheme: x.scheme, host: x.host, port: x.port, username: x.username, password: x.password },
    label: `${x.host}:${x.port}`,
    exitIp: x.host,
    country: x.country || "",
  });
  if (r?.ok) await rememberTarget({ kind: "pin", key: `${x.host}:${x.port}` });
  await refreshStatus({ rerunAnalysis: true });
  renderByoList();
}

async function renderByoList() {
  const list = el("byoList");
  if (!list) return;
  const saved = await store.get("local", "hproxy_byo", []);
  list.textContent = "";
  if (!saved.length) {
    list.innerHTML = `<p class="hint">Save a proxy to reuse it with one click.</p>`;
    return;
  }
  for (const x of saved) {
    const row = document.createElement("div");
    row.className = "row";
    const isOn = active && String(active.host) === String(x.host) && String(active.port) === String(x.port);
    row.classList.toggle("is-active", !!isOn);
    row.innerHTML =
      `<div class="row-main"><div class="row-addr">${escapeHtml(x.host)}<span class="port">:${escapeHtml(String(x.port))}</span></div>` +
      `<div class="row-meta"><span class="tag">${escapeHtml((x.scheme || "http").toUpperCase())}</span>${x.username ? `<span>auth</span>` : ""}</div></div>` +
      `<div class="row-acts"><button class="btn btn--ghost btn--sm js-del">Delete</button>` +
      `<button class="btn btn--primary btn--sm js-connect">${isOn ? "Disconnect" : "Connect"}</button></div>`;
    row.querySelector(".js-connect").addEventListener("click", async () => {
      if (isOn) return doDisconnect();
      await connectSaved(x);
    });
    row.querySelector(".js-del").addEventListener("click", async () => {
      const current = await store.get("local", "hproxy_byo", []);
      await store.set(
        "local",
        "hproxy_byo",
        current.filter((y) => !(y.host === x.host && String(y.port) === String(x.port))),
      );
      renderByoList();
    });
    list.appendChild(row);
  }
}

/* One search box for both surfaces. Version C puts a single command bar
   above everything, so the same query has to reach the saved proxies and
   not only the country list. Applied here rather than in the C skin,
   because "the search finds things" is behaviour, not decoration, and a
   skin that owns behaviour stops being a skin. */
function filterSaved() {
  const q = countryFilter.trim().toLowerCase();
  el("byoList")
    ?.querySelectorAll(".row")
    .forEach((row) => {
      row.hidden = !!q && !row.textContent.toLowerCase().includes(q);
    });
}

/* ── Proxies: your HProxy plans ─────────────────────────────────────── */
/*
   Sign in with the HProxy account rather than pasting an API key.

   Signing in should be all it takes: log in to HProxy, and the plans
   connect by themselves.

   chrome.identity.launchWebAuthFlow opens a real window at
   /extension/connect, the session cookie rides along because that is a
   top-level navigation, and the backend 302s back to
   <our-id>.chromiumapp.org with the key in the URL FRAGMENT.

   🔑 The key is a `proxies`-scoped key, minted by the backend. It can
   read your plans and generate a line from one, and it CANNOT buy
   anything. That distinction is enforced server-side in require_v1_any,
   not here: a client-side promise about authority is worth nothing.

   ⚠️ Two things had to be true on the backend before any of this worked,
   and both are new today:
     · /api/v1/* answers CORS preflights. It replied 405 before, so the
       browser cancelled every keyed request before sending it.
     · a `proxies` scope exists at all. The only alternative was a `buy`
       key, and a `buy` key can spend the customer's wallet.
*/

const API_KEY_STORE = "hproxy_apikey";

async function signIn() {
  const btn = el("signInBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Opening sign in";
  }
  try {
    const redirect = await new Promise((resolve, reject) =>
      chrome.identity.launchWebAuthFlow(
        { url: `${API}/extension/connect?ext=${chrome.runtime.id}`, interactive: true },
        (url) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(url)),
      ),
    );
    /* The key lives in the fragment specifically so it never reaches a
       server log or a Referer header. Parse it, never log it. */
    const key = new URLSearchParams(new URL(redirect).hash.slice(1)).get("key");
    if (!key) throw new Error("No key came back from HProxy.");
    await store.set("local", API_KEY_STORE, key);
    await loadPlans();
  } catch (e) {
    renderPlansMessage(`Could not sign in: ${e.message || e}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Sign in with HProxy";
    }
  }
}

async function signOut() {
  await store.set("local", API_KEY_STORE, "");
  await loadPlans();
}

function renderPlansMessage(message, withSignIn = true) {
  const list = el("mineList");
  if (!list) return;
  list.textContent = "";
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = message;
  list.appendChild(note);
  if (!withSignIn) return;
  const btn = document.createElement("button");
  btn.id = "signInBtn";
  btn.className = "btn btn--primary btn--sm";
  btn.textContent = "Sign in with HProxy";
  btn.addEventListener("click", signIn);
  list.appendChild(btn);
  cache.delete("signInBtn");
}

async function loadPlans() {
  const list = el("mineList");
  if (!list) return;
  const key = await store.get("local", API_KEY_STORE, "");
  if (!key) {
    renderPlansMessage("Sign in once and your plans appear here. No key to copy, nothing to paste.");
    return;
  }
  list.textContent = "";
  list.innerHTML = `<p class="hint">Loading your plans</p>`;
  try {
    const res = await fetch(`${API}/api/v1/plans`, { headers: { "X-API-Key": key } });
    if (res.status === 401) {
      await store.set("local", API_KEY_STORE, "");
      throw new Error("that sign in expired");
    }
    if (!res.ok) throw new Error(`HProxy returned ${res.status}`);
    const data = await res.json();
    renderPlans((data && data.plans) || []);
  } catch (e) {
    renderPlansMessage(`Could not load your plans: ${e.message || e}`);
  }
}

function prettyProduct(p) {
  return String(p || "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderPlans(plans) {
  const list = el("mineList");
  if (!list) return;
  list.textContent = "";
  if (!plans.length) {
    renderPlansMessage("No active plans on this account.", false);
    return;
  }
  for (const plan of plans) {
    const row = document.createElement("div");
    row.className = "row";
    const gb =
      plan.dataGbRemaining != null
        ? `<span class="tag">${Math.round(Number(plan.dataGbRemaining) * 100) / 100} GB left</span>`
        : "";
    row.innerHTML =
      `<div class="row-main"><div class="row-addr">${escapeHtml(prettyProduct(plan.product))}</div>` +
      `<div class="row-meta">${gb}</div></div>` +
      `<div class="row-acts"><button class="btn btn--primary btn--sm js-connect">Connect</button></div>`;
    row.querySelector(".js-connect").addEventListener("click", (e) => connectPlan(plan, row, e.currentTarget));
    list.appendChild(row);
  }
  const out = document.createElement("button");
  out.className = "link-btn";
  out.textContent = "Sign out";
  out.addEventListener("click", signOut);
  list.appendChild(out);
}

async function connectPlan(plan, row, btn) {
  let out = row.querySelector(".check-out");
  if (!out) {
    out = document.createElement("div");
    out.className = "check-out row-meta";
    row.querySelector(".row-main").appendChild(out);
  }
  out.textContent = "Generating a proxy";
  btn.disabled = true;
  try {
    const key = await store.get("local", API_KEY_STORE, "");
    const res = await fetch(`${API}/api/v1/plans/${encodeURIComponent(plan.id)}/generate`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "http", count: 1 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `generate ${res.status}`);
    const line = (data.lines || [])[0];
    if (!line) throw new Error("no proxy line returned");
    const p = parseLine(line);
    if (p.error || !p.username) throw new Error("unexpected proxy format");
    const proxy = { scheme: "http", host: p.host, port: p.port, username: p.username, password: p.password };
    const r = await send({ type: "pinConnect", proxy, label: prettyProduct(plan.product), exitIp: proxy.host });
    if (!r?.ok) throw new Error(r?.error || "connect failed");
    out.textContent = `Connected · ${proxy.host}:${proxy.port}`;
    out.style.color = "var(--ok)";
    await refreshStatus({ rerunAnalysis: true });
  } catch (e) {
    out.textContent = `Failed: ${e.message || e}`;
    out.style.color = "var(--danger)";
  } finally {
    btn.disabled = false;
  }
}

/* ── settings ───────────────────────────────────────────────────────── */

async function loadSettings() {
  settings = {
    firstSurface: await store.get("sync", "hproxy_first_surface", "proxies"),
    pinSurface: await store.get("sync", "hproxy_pin_surface", false),
  };
  document.querySelectorAll("[data-first-surface]").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.firstSurface === settings.firstSurface);
  });
}

async function setFirstSurface(value) {
  settings.firstSurface = value;
  await store.set("sync", "hproxy_first_surface", value);
  await loadSettings();
}

/* ── wiring ─────────────────────────────────────────────────────────── */

document.querySelectorAll("[data-surface]").forEach((btn) =>
  btn.addEventListener("click", () => setSurface(btn.dataset.surface)),
);
document.querySelectorAll("[data-first-surface]").forEach((btn) =>
  btn.addEventListener("click", () => setFirstSurface(btn.dataset.firstSurface)),
);

on("connSwitch", "click", toggleConnection);
on("hbutton", "click", toggleConnection);
on("disconnectBtn", "click", doDisconnect);
on("newIpBtn", "click", newIp);
on("quickBtn", "click", quickConnect);
on("reloadCountries", "click", loadCountries);
on("reanalyze", "click", () => runAnalysis());
on("countrySearch", "input", () => {
  countryFilter = el("countrySearch").value;
  renderCountries();
  filterSaved();
});
on("byoConnect", "click", byoConnectNow);
on("byoInput", "keydown", (e) => {
  if (e.key === "Enter") byoConnectNow();
});

/* ── init ───────────────────────────────────────────────────────────── */

/* A copy loaded by hand ("Load unpacked" from the source code) never updates,
   and it has another ID than the Chrome Web Store's copy: say so, with the way
   to the store's copy, which Chrome keeps up to date. */
async function flagHandLoadedCopy() {
  try {
    const self = await chrome.management?.getSelf?.();
    show("handLoaded", self?.installType === "development");
  } catch {
    /* a browser that does not say */
  }
}

async function init() {
  void flagHandLoadedCopy();
  await loadSettings();
  favCountries = await store.get("sync", "hproxy_fav_countries", []);
  lastTarget = await store.get("local", LAST_KEY, null);

  const last = await store.get("local", "hproxy_last_surface", null);
  setSurface(settings.pinSurface || !last ? settings.firstSurface : last);

  renderFavs();
  renderByoList();
  if (PLANS_LIVE) {
    show("plansBlock", true);
    loadPlans();
  }
  // In parallel with the connection checks, not after them.
  loadCountries();
  await refreshStatus({ rerunAnalysis: true });

  /* Refreshed when something changes, never on a timer. The worker says when
     a session starts, ends, fails over or has its login refused; Chrome says
     when another extension takes the proxy setting. */
  chrome.runtime?.onMessage?.addListener((msg) => {
    if (msg?.type === "statusChanged") refreshStatus();
  });
  chrome.proxy?.settings?.onChange?.addListener(() => refreshStatus());
}

init();
