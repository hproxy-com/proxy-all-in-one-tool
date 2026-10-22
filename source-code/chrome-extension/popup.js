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

   ── A PROXY CONNECTOR, NOT A FREE VPN (2026-10-12) ───────────────────
   The popup connects your own proxies first; the free exits are the extra.
   popup.html: on top the power button, the one control, as a VPN app has
   it, with the state in words and where you appear under it; while
   connected, the checks in one line that opens; then the tabs, My proxies
   first, as words with the H's crossbar. A saved proxy, a country or the fastest free one is a
   row you connect with one click. Until 1.0.3 the desktop app's Connect card
   stood on top: the switch, the route from this browser through the H, the
   H itself a button.

   Every element lookup still goes through `el()`, which returns null for
   anything the markup does not render, and every write checks first, so
   the markup can change without forking the logic.

   State lives in the background worker (background.js). This file is a
   remote control that reads and commands, and owns no session truth.
   ============================================================ */

import { analyze } from "./analyzer.js";
import { parseLine } from "./line.js";
import { httpTwinPort } from "./gateways.js";
import { riseIn, rollDigits, slideIn, unfold } from "./motion.js";

/* A saved proxy's last day, read the way the worker reads it (expiry.js, a
   plain script popup.html loads before this module). */
const { cleanDate, todayHere, daysLeft, expiryOf, dayWords, SOON } = globalThis.HPROXY_EXPIRY;
/* A saved proxy's name and note are kept as long as the computer app's
   library keeps them (proxy-engine/hproxy-places, library.rs). */
const MAX_NAME = 60;
const MAX_NOTE = 500;

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
/** Write text only if the markup has the element, and only when it changes (markRow says why). */
function text(id, value) {
  const node = el(id);
  if (node && node.textContent !== value) node.textContent = value;
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
let savedFilter = "";
/* My proxies' order: "recent" (as kept, the newest on top) or "expiring"
   (the soonest last day on top, the ended ones above all). Kept between
   openings. */
let savedSort = "recent";
const SORT_KEY = "hproxy_saved_sort";
let connectingCC = null;
/* Quick Connect was pressed and has not answered yet. */
let connectingQuick = false;
/* The saved proxy pressed last, until the worker answers ("host:port"). */
let connectingKey = null;
let active = null;
/* The worker is testing an exit or a proxy right now (from the last status). */
let busyNow = false;
/* The worker is testing free exits right now (from the last status). */
let searchingNow = false;
/* Where the switch goes when pressed: the last place connected to. */
let lastTarget = null;
let surface = "proxies";
let settings = { firstSurface: "proxies", pinSurface: false };
let analyzing = false;
/* The last status had a connection whose checks mean something (refreshStatus). */
let wasCheckable = false;

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

/* ── the power button and where you appear ──────────────────────────── */

/** Write text and, when it changed, let the new words rise in (motion.js). */
function textRise(id, value) {
  const node = el(id);
  if (!node || node.textContent === value) return;
  node.textContent = value;
  riseIn(node);
}

/* The line under the header while connected. With an address it reads
   "203.0.113.24 · United States · your proxy": a new address keeps its place
   and its digits roll over (New IP), new words rise in beside it, and a line
   that gains or loses its address rises in whole. The address shown last is
   remembered, so the next one rolls from it. */
function setSub(words, ip = "") {
  const box = el("statusSub");
  const ipNode = el("subIp");
  const wordsNode = el("subWords");
  if (!box || !ipNode || !wordsNode) return;
  // A no-break space: a box of words drops a plain space at its start.
  const line = ip ? `\u00a0· ${words}` : words;
  const hadIp = box.dataset.ip === "1";
  const wordsChanged = wordsNode.textContent !== line;
  box.dataset.ip = ip ? "1" : "0";
  ipNode.hidden = !ip;
  if (ip) rollDigits(ipNode, ip);
  wordsNode.textContent = line;
  if (hadIp !== !!ip) riseIn(box);
  else if (wordsChanged) riseIn(wordsNode);
}

/* The house's marks (square ends, like the H), drawn inline. */
const GLOBE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>`;
const KEY_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8m-3 3 2.5 2.5M13.5 9.5 16 12" /></svg>`;
const CROSS_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 6.5 11 11M17.5 6.5l-11 11" /></svg>`;
const PEN_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5h4l10.5-10.5-4-4L4.5 15.5z" /><path d="m12.5 7.5 4 4" /></svg>`;
const STAR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1-4.5-4.2 6.1-.8z" /></svg>`;
const H_SVG = `<svg class="solid" viewBox="0 0 22 26" aria-hidden="true"><path d="M0 0V0C3.98547 0 7.21633 3.23086 7.21633 7.21633V26H0V0Z" /><rect x="14.2188" width="7.21633" height="26" /><path d="M7.2349 26H0V15.9714C0 12.4548 2.85076 9.60408 6.36735 9.60408H14.2204V0H21.4367V10.4531C21.4367 13.9696 18.586 16.8204 15.0694 16.8204H7.2349V26Z" /></svg>`;

/** Where you appear: the exit's flag, or a globe when its country is not known yet. */
function setNowFlag(cc) {
  const node = el("nowFlag");
  if (!node || node.dataset.cc === cc) return;
  node.dataset.cc = cc;
  node.innerHTML = cc ? flagImg(cc) : GLOBE_SVG;
}

/* The place connected last: kept after every connect. A saved proxy of yours is also kept on
   its own, so a free country connected since never hides it from the switch. */
const LAST_KEY = "hproxy_last_target";
const LAST_OWN_KEY = "hproxy_last_own";
let lastOwn = null;
async function rememberTarget(target) {
  lastTarget = target;
  await store.set("local", LAST_KEY, target);
  if (target?.kind === "pin") {
    lastOwn = target;
    await store.set("local", LAST_OWN_KEY, target);
  }
}

/* What a press on the switch says with nothing of yours to connect (2026-10-18), the apps'
   words too. */
const ADD_FIRST = "Add your proxies first to start connecting!";

/* What the switch connects: your saved proxy used last, else the newest one you saved. Never a
   free proxy by itself (since 2026-10-17): free ones connect from the Free tab. Null: none
   saved. The apps' rule (hproxy-places switch_place). */
function switchTarget(list) {
  const key = lastOwn?.key ?? (lastTarget?.kind === "pin" ? lastTarget.key : null);
  return (key && list.find((x) => `${x.host}:${x.port}` === key)) || list[0] || null;
}

/* The switch. Connected, or still connecting: back to your own address. Otherwise your own
   proxy (switchTarget); with none, the place to paste them, and why. */
async function toggleConnection() {
  if (active || busyNow) return doDisconnect();
  const target = switchTarget(await store.get("local", "hproxy_byo", []));
  if (target) return connectSaved(target);
  setSurface("proxies");
  byoMsg(ADD_FIRST, "info");
  el("byoInput")?.focus();
}

/** Where the switch goes, in words: your saved proxy by its name when it has one; null with none. */
function nextWords() {
  const target = switchTarget(savedList);
  return target ? target.name || `${target.host}:${target.port}` : null;
}

/* Off, the switch's title and the line under it say where it goes; on, the
   title says it disconnects. Painted again when the saved list changes, as a
   name may have been given meanwhile. */
function paintNext() {
  const sw = el("connSwitch");
  const next = nextWords();
  if (sw) sw.title = sw.getAttribute("aria-checked") === "true" ? "Disconnect" : next ? `Connect to ${next}` : ADD_FIRST;
  text("heroHint", next ? `Connects to ${next}` : ADD_FIRST);
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
  searchingNow = searching;

  /* The header's phase, as the app names them: the look hangs on it. */
  const phase = on_ ? (searching ? "rotating" : "on") : busyNow ? "connecting" : "off";
  const conn = el("conn");
  if (conn) {
    conn.dataset.phase = phase;
    conn.toggleAttribute("data-failing", warn);
  }
  /* The power button: on while connected or connecting. Off, the line under
     it says where it goes: your proxy used last (paintNext), or, with none,
     that yours come first. */
  const lit = on_ || busyNow;
  el("connSwitch")?.setAttribute("aria-checked", String(lit));
  show("heroHint", !lit);
  paintNext();

  /* Where you appear, while there is a connection. Its checks only while
     there is something of it to measure: a proxy that refuses the login, has
     not answered, or is not the one in effect (a policy, another extension)
     carries nothing to check, and the line above already says why (its
     checks once said "Not carrying traffic" under "Waiting for an answer",
     over six rows of "could not measure"). */
  show("now", lit);
  const checkable = on_ && !policy && !hijacked && !refused && !silent;
  show("analyze", checkable);
  const cc = on_ && active.country ? String(active.country).toUpperCase() : "";
  setNowFlag(cc);
  const where = cc ? ccName(cc) : "";

  if (on_ && policy) {
    textRise("statusTitle", "Set by your organisation");
    setSub("A policy controls this browser's proxy, so no extension can change it.");
    show("newIpBtn", false);
  } else if (on_ && hijacked) {
    textRise("statusTitle", "Another extension is in control");
    setSub("Disable your other proxy or VPN extension, then reconnect.");
    show("newIpBtn", false);
  } else if (on_ && refused) {
    /* Reads exactly like a dead proxy otherwise, and the fix is the password. */
    textRise("statusTitle", "Login refused");
    setSub("The proxy refused the login. Check the username and password.");
    show("newIpBtn", false);
  } else if (silent) {
    /* No answer yet: while the worker still asks it again (background.js,
       pinRecheck), say so; "check the address" only once it stopped asking.
       A new phone or home line can take a while to answer the first time. */
    textRise("statusTitle", active.rechecking ? "Waiting for an answer" : "No answer yet");
    setSub(
      active.rechecking
        ? "Nothing came back yet. Asking it again."
        : "Nothing came back through this proxy. Check the address and the login.",
    );
    show("newIpBtn", false);
  } else if (on_) {
    textRise("statusTitle", failing ? "Stopped working" : "Connected");
    const ip = active.exitIp || active.host;
    const kind = active.mode === "vpn" ? "free proxy" : "your proxy";
    const said = [where, kind].filter(Boolean).join(" · ");
    if (searching) setSub("finding a new exit", ip);
    else if (testing) setSub("testing the connection", ip);
    else if (failing) setSub("This exit stopped working. Try New IP or another one.");
    else setSub(said, ip);
    show("newIpBtn", active.mode === "vpn");
  } else if (busyNow) {
    textRise("statusTitle", "Connecting");
    setSub(searching ? "Your pages stay where they are until one passes." : "Finding out which protocol it speaks");
    show("newIpBtn", false);
  } else {
    textRise("statusTitle", "Not connected");
    show("newIpBtn", false);
  }

  markQuick();
  markCountryStates();
  markSavedStates();
  followWaiting();

  /* Checked again when asked, when the exit changed, or when the connection
     just became one to check (a proxy that answered late); not on every
     status, as the checks make network calls. With nothing connected the run
     only clears the last verdict. */
  const due = rerunAnalysis || was !== active?.exitIp || (checkable && !wasCheckable);
  wasCheckable = checkable;
  if (due && (checkable || !on_)) runAnalysis();
  // A connection with nothing to check (a refused login, no answer yet) has settled as it is.
  else if (on_ && !checkable && !analyzing) el("analyze")?.setAttribute("data-state", "done");
}

/* ── the analyzer: the checks of this connection ───────────────────────
   One line under where you appear: the verdict with its mark and how many
   checks ran; pressed, it opens to one line per check, the sentence behind a
   check only where there is something to act on (since 2026-10-12; it was a
   list of seven rows with a sentence each, always open, and read as a wall
   of text). It opens by itself on a leak. Nothing runs while nothing is
   connected. */

const STATUS_WORD = { ok: "Clear", warn: "Check", bad: "Leaking", unknown: "Unknown", skip: "Idle" };

/** Open or close the checks' list: it unfolds, and what is under it moves down with it. */
function openChecks(open) {
  const head = el("checksToggle");
  if (!head || (head.getAttribute("aria-expanded") === "true") === open) return;
  head.setAttribute("aria-expanded", String(open));
  // Not while the whole section is hidden: nothing to see move.
  if (el("analyze")?.hidden) show("checksBody", open);
  else unfold(el("checksBody"), open);
}

/* A run asked for while one is going: it runs right after, on the connection
   as it is then, so the newest state always has the last word (a run on a
   proxy that had not answered yet once finished after it answered and left
   "Not carrying traffic" on screen). */
let analysisAgain = false;

async function runAnalysis() {
  const list = el("analyzeList");
  if (!list) return;
  if (analyzing) {
    analysisAgain = true;
    return;
  }
  if (!active) {
    list.textContent = "";
    setVerdict({ status: "skip", headline: "Not connected", detail: "" });
    text("checksCount", "");
    openChecks(false);
    // Settled: with nothing connected there is nothing to check.
    el("analyze")?.setAttribute("data-state", "done");
    return;
  }
  analyzing = true;

  el("analyze")?.setAttribute("data-state", "running");
  setVerdict({ status: "unknown", headline: "Checking this connection", detail: "" });
  text("checksCount", "");

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
    setVerdict(verdict);
    const ran = rows.filter((r) => r.status !== "skip").length;
    text("checksCount", ran ? `${ran} checks` : "");
    /* A leak, or a proxy carrying nothing, opens the list by itself. A time
       zone or a language that does not match the exit stays one line: it is
       so with almost every proxy abroad, and a list that opens every time is
       one people stop reading. */
    if (verdict.status === "bad") openChecks(true);
  } catch (e) {
    setVerdict({ status: "unknown", headline: "The check did not finish", detail: e?.message || String(e) });
  } finally {
    // Always released: a stuck flag would silently end every later check.
    el("analyze")?.setAttribute("data-state", "done");
    analyzing = false;
  }
  if (analysisAgain) {
    analysisAgain = false;
    runAnalysis();
  }
}

/* Reading order, fixed. The analyzer sorts by severity for its verdict,
   but the LIST stays in a stable order so the rows do not jump around
   between runs and make the panel feel unreliable. */
const ORDER = ["exit", "transparency", "dns", "webrtc", "timezone", "locale", "latency"];

/* The verdict's own sentence names the checks the list shows right under it
   ("Exit address, Header leaks"), or says the headline again ("Nothing is
   leaking"): it is the line's tooltip, not a line of its own. */
function setVerdict(v) {
  const node = el("verdict");
  if (!node) return;
  node.dataset.status = v.status;
  text("verdictHead", v.headline);
  const head = el("checksToggle");
  if (head) head.title = v.detail || "";
}

function analyzeRow(row) {
  const node = document.createElement("div");
  node.className = "arow";
  node.dataset.status = row.status;
  const state = STATUS_WORD[row.status] || "";

  /* ⚠️ Label, value and detail are DIRECT children on purpose: grid
     placement only applies to direct grid children (a wrapper once
     swallowed them and the label ran into the detail on one line).

     No state word: the mark carries the status for everyone (it is
     labelled), and "CLEAR" repeated down a column of healthy rows is the
     noise that teaches people to stop reading a security panel. */
  /* One line: its mark, its name, what it found. The sentence behind it is
     its tooltip when all is clear, and its second line when it is not. */
  node.title = row.detail || "";
  node.innerHTML =
    `<span class="arow-dot" role="img" aria-label="${escapeHtml(state)}"></span>` +
    `<span class="arow-label">${escapeHtml(row.label)}</span>` +
    `<span class="arow-value">${escapeHtml(row.headline || "")}</span>` +
    `<span class="arow-detail">${escapeHtml(row.detail || "")}</span>`;

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

/* The tabs are the computer app's Proxies parts (2026-10-12): words on a
   hairline, the current one in ink with the H's crossbar under it, which
   slides to the one you press, and the page under it comes in from that
   tab's side. Until then they were a track with a sliding blue pill. The
   order of the tabs decides the side. */
const SURFACES = ["proxies", "vpn"];

/** Put the crossbar under the current tab: at once, or sliding there. */
function placeBar(slide) {
  const bar = el("tabsBar");
  const on = document.querySelector("#surfaces > .tab.is-on");
  if (!bar || !on) return;
  if (!slide) bar.dataset.still = "";
  bar.style.transform = `translateX(${on.offsetLeft}px)`;
  bar.style.width = `${on.offsetWidth}px`;
  if (!slide) requestAnimationFrame(() => requestAnimationFrame(() => delete bar.dataset.still));
}

function setSurface(next, still = false) {
  const from = SURFACES.indexOf(next) > SURFACES.indexOf(surface) ? "right" : "left";
  const moved = next !== surface;
  surface = next;
  document.querySelectorAll("#surfaces > [data-surface]").forEach((btn) => {
    const on = btn.dataset.surface === next;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-selected", String(on));
  });
  placeBar(moved && !still);
  show("surface-proxies", next === "proxies");
  show("surface-vpn", next === "vpn");
  if (moved && !still) slideIn(el(`surface-${next}`), from);
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
  list.textContent = "";
  if (!countries.length) {
    list.innerHTML = `<p class="hint">No countries right now. Press Refresh.</p>`;
    return;
  }
  const matches = countries.filter(
    (c) =>
      !q ||
      ccName(c.country_code).toLowerCase().includes(q) ||
      c.country_code.toLowerCase().includes(q),
  );
  if (!matches.length) {
    list.innerHTML = `<p class="hint">No country matches "${escapeHtml(countryFilter.trim())}".</p>`;
    return;
  }
  const favSet = new Set(favCountries.map((c) => c.toUpperCase()));
  for (const c of matches) {
    const cc = c.country_code.toUpperCase();
    list.appendChild(countryRow(cc, c.count, favSet.has(cc)));
  }
  markCountryStates();
}

/* The count is free IPs in that country, not places: "2497 locations" for
   the United States promised cities that do not exist. */
function ipCount(count) {
  const n = Math.max(0, Number(count) || 0);
  return `${n.toLocaleString("en-US")} IP${n === 1 ? "" : "s"}`;
}

/* ── the rows you connect through ──────────────────────────────────────
   A saved proxy, a country and the fastest free proxy are the same kind of
   row: what it is on the left, how it stands on the right. Pressing one
   connects it; pressing the one in use disconnects. At rest a row is only
   its name and its second line; pointed at, it says Connect (popup.css). */

const SPIN = `<span class="spin"></span>`;

/* The last press that did not connect: its row says why in place of its
   second line, until the next press. `at` is "quick", a country code, or a
   saved proxy's "host:port". */
let failedAt = null;

/** A press that went nowhere: remember why, for its row to say. */
function noteFailure(at, r) {
  failedAt = r && r.ok === false ? { at, error: r.error || "Could not connect. Try again." } : null;
}

/** How a row stands: connecting, in use, in use but broken, failed, or none. */
function markRow(row, { turning, inUse, broken, failed, brokenWord = "Stopped" }) {
  row.classList.toggle("is-connecting", turning);
  row.classList.toggle("is-active", inUse && !turning && !broken);
  row.classList.toggle("is-warn", inUse && !turning && broken);
  row.classList.toggle("is-failed", failed && !turning && !inUse);
  /* Written only when it changes: every status refresh passes here, and a
     row whose words are rewritten under a still mouse loses its hover (its
     Connect and its × vanish) until the mouse moves again. */
  const go = row.querySelector(".row-go");
  const goNow = turning ? SPIN : inUse && broken ? brokenWord : inUse ? "Connected" : "Connect";
  if (go && go.innerHTML !== goNow) go.innerHTML = goNow;
  const meta = row.querySelector(".row-meta");
  if (meta && row.dataset.meta !== undefined) {
    const metaNow = failed && !turning && !inUse ? failedAt.error : row.dataset.meta;
    if (meta.textContent !== metaNow) meta.textContent = metaNow;
  }
}

/** Enter or Space on a focused row presses it, as a click does. */
function pressable(row, press) {
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.addEventListener("click", press);
  row.addEventListener("keydown", (e) => {
    if (e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    press();
  });
}

/* A press elsewhere is waiting for its answer: until it comes, the row in
   use stays in use (pages stay where they are until the new one passes) and
   is not the one connecting. */
const pressedElsewhere = (self) =>
  (self !== "quick" && connectingQuick) || (!!connectingCC && connectingCC !== self) || (!!connectingKey && connectingKey !== self);

/* A country: its flag, its name, how many free IPs it has, and a star to
   keep it on top. */
function countryRow(cc, count, faved) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.cc = cc;
  row.dataset.meta = ipCount(count);
  row.innerHTML =
    `<span class="row-lead">${flagImg(cc)}</span>` +
    `<span class="row-main">` +
    `<span class="row-name">${escapeHtml(ccName(cc))}</span>` +
    `<span class="row-meta">${escapeHtml(row.dataset.meta)}</span>` +
    `</span>` +
    `<button type="button" class="row-star${faved ? " on" : ""}" title="${faved ? "Remove from favorites" : "Keep it on top"}" aria-pressed="${faved}">${STAR_SVG}</button>` +
    `<span class="row-go">Connect</span>`;
  pressable(row, () => connectCountry(cc));
  row.querySelector(".row-star").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavCountry(cc);
  });
  return row;
}

/* The country you picked says so. A Quick Connect that lands in a country
   marks its own row, not that country's: one row in use, never two. */
function pickedCountry() {
  return active && active.mode === "vpn" && lastTarget?.kind === "vpn" && lastTarget.country
    ? String(lastTarget.country).toUpperCase()
    : null;
}

function markCountryStates() {
  const picked = pickedCountry();
  document.querySelectorAll(".row[data-cc]").forEach((row) => {
    const cc = row.dataset.cc;
    const inUse = picked === cc;
    markRow(row, {
      turning: connectingCC === cc || (inUse && searchingNow && !pressedElsewhere(cc)),
      inUse,
      broken: inUse && !!active.failing,
      failed: failedAt?.at === cc,
    });
  });
}

/* The fastest free proxy: any country, the first exit that passes. Its
   second line says where it landed. */
function markQuick() {
  const row = el("quickBtn");
  if (!row) return;
  const inUse = !!active && active.mode === "vpn" && lastTarget?.kind === "vpn" && !lastTarget.country;
  const turning = connectingQuick || (inUse && searchingNow && !pressedElsewhere("quick"));
  const broken = inUse && !!active.failing;
  const failed = failedAt?.at === "quick";
  markRow(row, { turning, inUse, broken, failed });
  const where = inUse && active.country ? ccName(String(active.country).toUpperCase()) : "";
  text(
    "quickSub",
    turning
      ? "Testing free proxies"
      : inUse
        ? broken
          ? "This exit stopped working"
          : where
            ? `Now in ${where}`
            : `Now on ${active.exitIp}`
        : failed
          ? failedAt.error
          : "Any country, tested before you use it",
  );
}

async function connectCountry(cc) {
  cc = cc.toUpperCase();
  if (pickedCountry() === cc && !active.failing) return doDisconnect();
  show("byoMsg", false);
  connectingCC = cc;
  failedAt = null;
  markQuick();
  markCountryStates();
  const r = await send({ type: "vpnConnect", country: cc, protocol: "" });
  connectingCC = null;
  noteFailure(cc, r);
  if (r?.ok) await rememberTarget({ kind: "vpn", country: cc });
  await refreshStatus({ rerunAnalysis: true });
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
  for (const fav of favCountries) {
    const cc = fav.toUpperCase();
    list.appendChild(countryRow(cc, counts.get(cc) ?? 0, true));
  }
  markCountryStates();
}

/* ── connect actions ────────────────────────────────────────────────── */

async function quickConnect() {
  const inUse = !!active && active.mode === "vpn" && lastTarget?.kind === "vpn" && !lastTarget.country;
  if (inUse && !active.failing) return doDisconnect();
  show("byoMsg", false);
  connectingQuick = true;
  failedAt = null;
  markQuick();
  markCountryStates();
  const r = await send({ type: "vpnConnect", country: "", protocol: "" });
  connectingQuick = false;
  noteFailure("quick", r);
  if (r?.ok) await rememberTarget({ kind: "vpn", country: "" });
  await refreshStatus({ rerunAnalysis: true });
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
  if (r?.active?.note) setSub(r.active.note);
  else if (r && r.ok === false) setSub(r.error || "Could not change the exit.");
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


/* The note under the field speaks of the proxy pasted last ("host:port"):
   it goes once another one is in use, once nothing is (after it said
   Connected), or when a row is pressed. Never while the paste is still
   connecting (`pasting`): the session then is still the one before. */
let byoNoteKey = null;
let pasting = false;

function byoMsg(message, kind, key = null) {
  const node = el("byoMsg");
  if (!node) return;
  byoNoteKey = key;
  node.hidden = false;
  node.className = `msg ${kind || "info"}`;
  node.textContent = message;
}

async function byoConnectNow() {
  if (pasting) return;
  pasting = true;
  try {
    await pasteConnect();
  } finally {
    pasting = false;
  }
}

async function pasteConnect() {
  const parsed = parseByo(el("byoInput")?.value);
  if (parsed.error) return byoMsg(`${parsed.error}`, "bad");
  failedAt = null;

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
  /* A SOCKS5 line of ours with a login: the same gateway's HTTP port instead
     (gateways.js), said in the message below. */
  const twin = hasAuth ? httpTwinPort(parsed.host, parsed.port) : null;
  if (twin) {
    parsed.port = twin;
    parsed.scheme = "http";
  }
  const key = `${parsed.host}:${parsed.port}`;
  const twinNote = twin ? ` Chrome cannot log in over SOCKS5, so it goes through the same line's HTTP port ${twin}.` : "";
  const tried = twin ? ["http"] : schemesToTry(parsed.scheme, hasAuth);
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
      ? `It answered over ${proxy.scheme.toUpperCase()}. Connecting.${twinNote}${socksNote}`
      : `No answer yet. Connecting over ${proxy.scheme.toUpperCase()} and asking it again.${twinNote}${socksNote}`,
    "info",
    key,
  );
  const r = await send({
    type: "pinConnect",
    proxy,
    label: `${proxy.host}:${proxy.port}`,
    exitIp: found?.exitIp || proxy.host,
    country: found?.country || "",
    // Kept in the saved list by the worker if it answers later (background.js, keepSaved).
    keep: true,
  });
  done();

  if (!r?.ok) {
    byoMsg(`Could not connect: ${r?.error || "no route to that proxy"}`, "bad", key);
    return;
  }

  /* A proxy that works is one you want kept: saving is a consequence of
     connecting, never a second decision. One that answered at once is saved
     here; one that answers a little later is saved by the worker the moment
     it does (and this message follows, see refreshStatus). One that refused
     the login, or never answers, is not saved: it would only sit in the list
     looking usable. */
  const how = proxy.scheme.toUpperCase();
  const refused = !!r.active?.loginRefused;
  const answered = r.active?.verified !== false;
  const country = r.active?.country || found?.country || "";
  if (!refused && answered) {
    await saveByo({ ...proxy, country });
    await rememberTarget({ kind: "pin", key: `${proxy.host}:${proxy.port}` });
  }
  const where = country ? ` · ${ccName(country)}` : "";
  waitingFor = null;
  if (refused) byoMsg("The proxy refused the login. Check the username and password. Not saved.", "bad", key);
  else if (!answered) {
    waitingFor = { key: `${proxy.host}:${proxy.port}`, how };
    byoMsg(`Connected over ${how}. Nothing came back yet, so it is asked again in a moment and saved once it answers.${socksNote}`, "info", key);
  } else {
    byoMsg(`Connected over ${how}${where}. Saved.${twinNote}`, "ok", key);
    // It lives in the list now: the field is free for the next one.
    const input = el("byoInput");
    if (input) input.value = "";
  }
  await refreshStatus({ rerunAnalysis: true });
}

/* A proxy connected without an answer: the message under the field follows
   it, so "asked again" turns into "Connected · Netherlands. Saved." the
   moment the worker hears back, or into the plain truth once it stops
   asking. */
let waitingFor = null;
function followWaiting() {
  if (!waitingFor) return;
  const key = waitingFor.key;
  const same = !!active && active.mode === "pin" && `${active.host}:${active.port}` === key;
  if (!same) {
    waitingFor = null;
    return;
  }
  if (active.verified === true) {
    const where = active.country ? ` · ${ccName(active.country)}` : "";
    byoMsg(`Connected over ${waitingFor.how}${where}. It answered, and it is saved.`, "ok", key);
    waitingFor = null;
  } else if (!active.rechecking) {
    byoMsg(`Connected over ${waitingFor.how}, but nothing came back through it. Check the address and the login. Not saved.`, "bad", key);
    waitingFor = null;
  }
}

/** Store a proxy in the saved list, newest first, no duplicates. Pasted
    again, it keeps what was written about it (its name, last day and note). */
async function saveByo(proxy) {
  const list = await store.get("local", "hproxy_byo", []);
  const key = `${proxy.host}:${proxy.port}`;
  const before = list.find((x) => `${x.host}:${x.port}` === key);
  const next = [{ ...before, ...proxy, label: key }, ...list.filter((x) => `${x.host}:${x.port}` !== key)].slice(0, 50);
  await store.set("local", "hproxy_byo", next);
}

/** Connect to a saved proxy, and make it the place the switch goes back to.
    One past its last day connects all the same (plans get extended) and
    says so. */
async function connectSaved(x) {
  const key = `${x.host}:${x.port}`;
  show("byoMsg", false);
  if (cleanDate(x.expires) && expiryOf(x.expires)?.tone === "bad") {
    byoMsg(`Its plan ended on ${dayWords(x.expires)}. Connecting anyway.`, "warn", key);
  }
  connectingKey = key;
  failedAt = null;
  markSavedStates();
  markQuick();
  markCountryStates();
  const r = await send({
    type: "pinConnect",
    proxy: { scheme: x.scheme, host: x.host, port: x.port, username: x.username, password: x.password },
    label: key,
    exitIp: x.host,
    country: x.country || "",
  });
  connectingKey = null;
  noteFailure(key, r);
  if (r?.ok) await rememberTarget({ kind: "pin", key });
  await refreshStatus({ rerunAnalysis: true });
}

/** Whether the session running now is this saved proxy. */
function isSavedOn(x) {
  return !!active && String(active.host) === String(x.host) && String(active.port) === String(x.port);
}

/* The saved rows follow the session the way the country rows do
   (markCountryStates): refreshStatus calls this on every change, so a
   disconnect from the switch or the worker never leaves a row saying
   Connected. A proxy in use that refused the login or has not answered says
   so on its row as the header does. The note "Connected over …" goes with
   the session it described. */
function markSavedStates() {
  document.querySelectorAll("#byoList .row[data-key]").forEach((row) => {
    const key = row.dataset.key;
    const inUse = !!active && `${active.host}:${active.port}` === key;
    const silent = inUse && active.mode === "pin" && active.verified === false;
    markRow(row, {
      turning: connectingKey === key || (inUse && silent && !!active.rechecking && !pressedElsewhere(key)),
      inUse,
      broken: inUse && (!!active.loginRefused || silent),
      brokenWord: inUse && active.loginRefused ? "Login refused" : "No answer",
      failed: failedAt?.at === key,
    });
  });
  const note = el("byoMsg");
  if (note && !note.hidden && !pasting) {
    const onKey = active ? `${active.host}:${active.port}` : null;
    const elsewhere = !!byoNoteKey && !!onKey && onKey !== byoNoteKey;
    if (elsewhere || (!active && !busyNow && note.classList.contains("ok"))) note.hidden = true;
  }
}

/** A note's first line, for a row; the whole note is the row's tooltip. */
const firstLine = (note) => (note ? String(note).split("\n")[0].trim() : "");

/* A saved proxy: its country's flag (a globe until it is known), its name or
   else its address, a key when it carries a login; under it how many days
   its plan has left, then the address under a name, the country, what it
   speaks and the first line of its note. Pointed at, it offers Connect, the
   pencil for its name, last day and note, and the × that removes it. */
function savedRow(x, today = todayHere()) {
  const key = `${x.host}:${x.port}`;
  const cc = /^[A-Za-z]{2}$/.test(x.country || "") ? String(x.country).toUpperCase() : "";
  const left = cleanDate(x.expires) ? expiryOf(x.expires, today) : null;
  const called = x.name || key;
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.key = key;
  row.dataset.meta = [x.name ? key : "", cc ? ccName(cc) : "", (x.scheme || "http").toUpperCase(), firstLine(x.note)]
    .filter(Boolean)
    .join(" · ");
  if (x.note) row.title = x.note;
  row.innerHTML =
    `<span class="row-lead">${cc ? flagImg(cc) : GLOBE_SVG}</span>` +
    `<span class="row-main">` +
    `<span class="row-name">` +
    (x.name ? escapeHtml(x.name) : `${escapeHtml(x.host)}<span class="port">:${escapeHtml(String(x.port))}</span>`) +
    (x.username ? `<span class="mark" title="With a login">${KEY_SVG}</span>` : "") +
    `</span>` +
    `<span class="row-sub">` +
    (left
      ? `<span class="row-days" data-tone="${left.tone}" title="Last day: ${escapeHtml(dayWords(x.expires, today))}">${left.words}</span>`
      : "") +
    `<span class="row-meta">${escapeHtml(row.dataset.meta)}</span>` +
    `</span>` +
    `</span>` +
    `<span class="row-go">Connect</span>` +
    `<button type="button" class="row-edit" title="Name, expiry and note" aria-expanded="false" aria-label="Name, expiry and note of ${escapeHtml(called)}">${PEN_SVG}</button>` +
    `<button type="button" class="row-del" title="Remove" aria-label="Remove ${escapeHtml(called)}">${CROSS_SVG}</button>`;
  // Decided when pressed, not when drawn: the session may have changed since.
  pressable(row, () => (isSavedOn(x) ? doDisconnect() : connectSaved(x)));
  row.querySelector(".row-edit").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleEditor(row, x);
  });
  row.querySelector(".row-del").addEventListener("click", async (e) => {
    e.stopPropagation();
    const current = await store.get("local", "hproxy_byo", []);
    await store.set(
      "local",
      "hproxy_byo",
      current.filter((y) => !(y.host === x.host && String(y.port) === String(x.port))),
    );
    // The storage listener draws the list again.
  });
  return row;
}

/* Every proxy that worked, newest first. The tab counts them; past six a
   search box finds one. */
let savedList = [];

async function renderByoList() {
  savedList = await store.get("local", "hproxy_byo", []);
  const count = el("savedCount");
  if (count) {
    count.textContent = savedList.length ? String(savedList.length) : "";
    count.hidden = !savedList.length;
    placeBar(false);
  }
  show("savedSearchBox", savedList.length > 6);
  drawExpiryNote();
  drawSaved();
  // A name given meanwhile: the line under the switch says it.
  paintNext();
}

/* Drawn from the list each time, matches only: a row hidden in place would
   leave its hairline above the next one. Searched by name, address, country,
   protocol or note; in the order chosen over the list (savedSort). An open
   editor comes back under its row, the caret with it when it was there. */
function drawSaved() {
  const list = el("byoList");
  if (!list) return;
  const caretIn = !!document.activeElement?.closest?.(".row-editor");
  list.textContent = "";
  if (!savedList.length) {
    editing = null;
    // Someone who has proxies pastes them (2026-10-17: no "try a free one" line); the free ones
    // keep their own tab.
    list.innerHTML = `<p class="hint">Paste a proxy above. Each one that works is kept here.</p>`;
    return;
  }
  const q = savedFilter.trim().toLowerCase();
  const words = (x) =>
    `${x.name || ""} ${x.host}:${x.port} ${x.country ? ccName(x.country) : ""} ${x.scheme || "http"} ${x.note || ""}`.toLowerCase();
  // YYYY-MM-DD orders as text the way it orders as days; ties keep the kept order.
  const lastDay = (x) => cleanDate(x.expires) || "9999";
  const ordered = savedSort === "expiring" ? [...savedList].sort((a, b) => lastDay(a).localeCompare(lastDay(b))) : savedList;
  const matches = ordered.filter((x) => !q || words(x).includes(q));
  if (!matches.length) {
    editing = null;
    list.innerHTML = `<p class="hint">None of your proxies matches "${escapeHtml(savedFilter.trim())}".</p>`;
    return;
  }
  const today = todayHere();
  let editRow = null;
  for (const x of matches) {
    const row = savedRow(x, today);
    if (editing?.key === row.dataset.key) editRow = row;
    list.appendChild(row);
  }
  if (editRow) placeEditor(editRow, caretIn ? "back" : "none");
  else editing = null;
  markSavedStates();
}

/* Over the list once any saved proxy has a last day: how many plans end
   within three days and how many have ended, else when the next one ends;
   and the switch between newest first and the soonest last day first. */
function drawExpiryNote() {
  const box = el("expiryNote");
  const said = el("expiryWords");
  if (!box || !said) return;
  const today = todayHere();
  const dated = savedList.map((x) => cleanDate(x.expires)).filter(Boolean);
  box.hidden = !dated.length;
  if (!dated.length) return;
  const days = dated.map((day) => daysLeft(day, today));
  const soon = days.filter((d) => d >= 0 && d <= SOON).length;
  const ended = days.filter((d) => d < 0).length;
  const parts = [];
  if (soon) parts.push(`<span data-tone="warn">${soon} ${soon === 1 ? "expires" : "expire"} within ${SOON} days</span>`);
  if (ended) parts.push(`<span data-tone="bad">${ended} ${ended === 1 ? "has" : "have"} expired</span>`);
  if (!parts.length) parts.push(`The next plan ends on ${escapeHtml(dayWords([...dated].sort()[0], today))}`);
  said.innerHTML = parts.join(" · ");
  const sort = el("expirySort");
  if (sort) {
    sort.textContent = savedSort === "expiring" ? "Newest first" : "Soonest first";
    sort.title = savedSort === "expiring" ? "Show the proxies saved last on top" : "Show the soonest last day on top";
  }
}

/* ── a saved proxy's name, last day and note ────────────────────────── */

/* The editor open under a saved proxy and what is typed in it so far
   ({ key, name, expires, note, focus }): the list is drawn again whenever the
   saved list changes (the worker may save a proxy meanwhile), and the editor
   comes back as it was. One at a time. */
let editing = null;

/** Open the editor under `row`, or close it when it is open there already. */
function toggleEditor(row, x) {
  const key = `${x.host}:${x.port}`;
  const wasHere = editing?.key === key;
  closeEditor();
  if (wasHere) return;
  editing = { key, name: x.name || "", expires: cleanDate(x.expires) || "", note: x.note || "", focus: "name" };
  placeEditor(row, "first");
}

function closeEditor() {
  editing = null;
  document.querySelectorAll("#byoList .row-editor").forEach((box) => box.remove());
  document.querySelectorAll("#byoList .row-edit[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

/* The editor of `editing`, under its row: Save or Enter keeps the words,
   Cancel or Escape leaves them as they were; a day that is not one says so
   and the editor stays. `caret`: "first" puts it in the name, "back" where
   it was before the list was drawn again, "none" leaves it alone. */
function placeEditor(row, caret) {
  const draft = editing;
  const box = document.createElement("div");
  box.className = "row-editor";
  box.innerHTML =
    `<div class="editor-pair">` +
    `<label class="editor-field"><span class="editor-label">Name</span>` +
    `<input class="input" data-field="name" maxlength="${MAX_NAME}" placeholder="Like Netflix US" autocomplete="off" spellcheck="false" /></label>` +
    `<label class="editor-field"><span class="editor-label" data-left>Expires on</span>` +
    `<input class="input" data-field="expires" type="date" min="2000-01-01" max="2199-12-31" /></label>` +
    `</div>` +
    `<label class="editor-field"><span class="editor-label">Note</span>` +
    `<input class="input" data-field="note" maxlength="${MAX_NOTE}" placeholder="Where it is from, what it is for" autocomplete="off" spellcheck="false" /></label>` +
    `<p class="msg bad" data-problem hidden></p>` +
    `<div class="editor-actions">` +
    `<button type="button" class="btn btn--primary btn--sm" data-act="save">Save</button>` +
    `<button type="button" class="link-btn" data-act="cancel">Cancel</button>` +
    `<button type="button" class="link-btn" data-act="clear" title="It does not expire">No end date</button>` +
    `</div>`;
  const field = (name) => box.querySelector(`[data-field="${name}"]`);
  const problem = box.querySelector("[data-problem]");
  const say = (words) => {
    problem.hidden = !words;
    problem.textContent = words || "";
  };
  // How long the day typed leaves, beside its label, as the row's chip will say it.
  const showLeft = () => {
    const left = expiryOf(cleanDate(field("expires").value));
    box.querySelector("[data-left]").textContent = left ? `Expires on · ${left.words}` : "Expires on";
    box.querySelector('[data-act="clear"]').hidden = !field("expires").value;
  };
  for (const name of ["name", "expires", "note"]) field(name).value = draft[name];
  showLeft();

  const save = async () => {
    if (field("expires").validity?.badInput) return say("That is not a day of the calendar.");
    const why = await describeSaved(draft.key, {
      name: field("name").value,
      expires: field("expires").value,
      note: field("note").value,
    });
    if (why) return say(why);
    closeEditor();
    // The storage listener draws the list again, with the new words.
  };
  const leave = () => {
    closeEditor();
    row.querySelector(".row-edit")?.focus();
  };
  box.addEventListener("input", (e) => {
    const name = e.target.dataset?.field;
    if (!name) return;
    draft[name] = e.target.value;
    if (name === "expires") showLeft();
    say(null);
  });
  box.addEventListener("focusin", (e) => {
    if (e.target.dataset?.field) draft.focus = e.target.dataset.field;
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input")) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      leave();
    }
  });
  box.querySelector('[data-act="save"]').addEventListener("click", () => void save());
  box.querySelector('[data-act="cancel"]').addEventListener("click", leave);
  box.querySelector('[data-act="clear"]').addEventListener("click", () => {
    field("expires").value = "";
    draft.expires = "";
    showLeft();
    field("expires").focus();
  });

  row.after(box);
  row.querySelector(".row-edit")?.setAttribute("aria-expanded", "true");
  const at = field(draft.focus) || field("name");
  if (caret === "first") {
    at.focus();
    at.select();
  } else if (caret === "back") {
    at.focus();
    // A date field has no caret to place.
    if (at.type !== "date") at.setSelectionRange(at.value.length, at.value.length);
  }
}

/** Keep what was written about a saved proxy: its name, its last day and a
    note, an empty field taking its word away. Says why when it cannot. */
async function describeSaved(key, { name, expires, note }) {
  const day = String(expires || "").trim();
  if (day && !cleanDate(day)) return "That is not a day between 2000 and 2199.";
  const list = await store.get("local", "hproxy_byo", []);
  const at = list.findIndex((x) => `${x.host}:${x.port}` === key);
  if (at < 0) return "This proxy is no longer in your list.";
  // Counted in characters, as the computer app's library counts them.
  const tidy = (s, most) => Array.from(String(s || "").replace(/\s+/g, " ").trim()).slice(0, most).join("").trim();
  const next = { ...list[at] };
  const put = (field, value) => {
    if (value) next[field] = value;
    else delete next[field];
  };
  put("name", tidy(name, MAX_NAME));
  put("expires", day);
  put("note", tidy(note, MAX_NOTE));
  await store.set("local", "hproxy_byo", list.map((x, i) => (i === at ? next : x)));
  if (next.expires) countFeature("expiry");
  if (next.note) countFeature("notes");
  return null;
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
  /* A plan is a row like a saved proxy: the H, the product, what is left. */
  for (const plan of plans) {
    const row = document.createElement("div");
    row.className = "row";
    const left = plan.dataGbRemaining != null ? `${Math.round(Number(plan.dataGbRemaining) * 100) / 100} GB left` : "";
    row.innerHTML =
      `<span class="row-lead">${H_SVG}</span>` +
      `<span class="row-main">` +
      `<span class="row-name">${escapeHtml(prettyProduct(plan.product))}</span>` +
      `<span class="row-meta">${escapeHtml(left)}</span>` +
      `</span>` +
      `<span class="row-go">Connect</span>`;
    pressable(row, () => connectPlan(plan, row));
    list.appendChild(row);
  }
  const out = document.createElement("button");
  out.className = "link-btn";
  out.textContent = "Sign out";
  out.addEventListener("click", signOut);
  list.appendChild(out);
}

async function connectPlan(plan, row) {
  if (row.classList.contains("is-connecting")) return;
  const out = row.querySelector(".row-meta");
  const go = row.querySelector(".row-go");
  row.classList.remove("is-failed");
  row.classList.add("is-connecting");
  go.innerHTML = SPIN;
  out.textContent = "Making a proxy line";
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
    out.textContent = `${proxy.host}:${proxy.port}`;
    await refreshStatus({ rerunAnalysis: true });
  } catch (e) {
    row.classList.add("is-failed");
    out.textContent = `Could not connect: ${e.message || e}`;
  } finally {
    row.classList.remove("is-connecting");
    go.textContent = "Connect";
  }
}

/* ── usage counts ───────────────────────────────────────────────────── */

/* The question until it is answered, then "Usage counts" in the footer: the
   switch and the last report exactly as it went (background.js keeps the
   book, usage.js). Nothing is counted before a yes. */
async function drawUsage() {
  const r = await send({ type: "usageGet" });
  if (!r?.ok) return;
  show("usageAsk", r.answer === "unasked");
  show("usageLink", r.answer !== "unasked");
  text("usageLink", r.answer === "yes" ? "Usage counts: on" : "Usage counts: off");
  const box = el("usageOn");
  if (box) box.checked = r.answer === "yes";
  text("usageLast", r.last ? JSON.stringify(r.last, null, 2) : "Nothing sent yet. The first report goes the day after you said yes.");
}

async function answerUsage(yes) {
  await send({ type: "usageAnswer", yes });
  await drawUsage();
}

/* What only the popup sees, once per opening: a feature used. */
const usageSaid = new Set();
function countFeature(name) {
  if (usageSaid.has(name)) return;
  usageSaid.add(name);
  void send({ type: "usageCount", event: { kind: "feature", name } });
}

/* ── settings ───────────────────────────────────────────────────────── */

/* Which tab opens first, as an earlier version let people set it (kept in
   sync storage): My proxies unless they chose otherwise. */
async function loadSettings() {
  settings = {
    firstSurface: await store.get("sync", "hproxy_first_surface", "proxies"),
    pinSurface: await store.get("sync", "hproxy_pin_surface", false),
  };
}

/* ── wiring ─────────────────────────────────────────────────────────── */

document.querySelectorAll("#surfaces > [data-surface]").forEach((btn) =>
  btn.addEventListener("click", () => setSurface(btn.dataset.surface)),
);

on("connSwitch", "click", toggleConnection);
on("newIpBtn", "click", newIp);
const quickRow = el("quickBtn");
if (quickRow) pressable(quickRow, quickConnect);
on("reloadCountries", "click", loadCountries);
on("checksToggle", "click", () => {
  const open = el("checksToggle").getAttribute("aria-expanded") !== "true";
  if (open) countFeature("leak_checks");
  openChecks(open);
});
on("reanalyze", "click", () => {
  countFeature("leak_checks");
  runAnalysis();
});
on("countrySearch", "input", () => {
  countryFilter = el("countrySearch").value;
  renderCountries();
});
on("savedSearch", "input", () => {
  savedFilter = el("savedSearch").value;
  if (savedFilter.trim()) countFeature("search");
  drawSaved();
});
on("usageYes", "click", () => answerUsage(true));
on("usageNo", "click", () => answerUsage(false));
on("usageOn", "change", () => answerUsage(!!el("usageOn")?.checked));
on("usageLink", "click", () => show("usagePanel", !!el("usagePanel")?.hidden));
// A crash of the popup counts (after a yes), never what it said.
window.addEventListener("error", () => void send({ type: "usageCount", event: { kind: "crash", part: "window" } }));
on("expirySort", "click", () => {
  savedSort = savedSort === "expiring" ? "recent" : "expiring";
  void store.set("local", SORT_KEY, savedSort);
  drawExpiryNote();
  drawSaved();
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
  text("footNote", `Version ${chrome.runtime.getManifest().version}`);
  await loadSettings();
  favCountries = await store.get("sync", "hproxy_fav_countries", []);
  lastTarget = await store.get("local", LAST_KEY, null);
  lastOwn = await store.get("local", LAST_OWN_KEY, null);

  const last = await store.get("local", "hproxy_last_surface", null);
  // Where the popup opens is not a move: the page and the crossbar are just there.
  setSurface(settings.pinSurface || !last ? settings.firstSurface : last, true);
  // Inter arriving changes the tabs' widths: the crossbar follows, without a slide.
  document.fonts?.ready.then(() => placeBar(false)).catch(() => {});

  renderFavs();
  savedSort = (await store.get("local", SORT_KEY, "recent")) === "expiring" ? "expiring" : "recent";
  renderByoList();
  if (PLANS_LIVE) {
    show("plansBlock", true);
    loadPlans();
  }
  // In parallel with the connection checks, not after them.
  loadCountries();
  await refreshStatus({ rerunAnalysis: true });
  // Opened on a proxy that has not answered yet: the worker asks it now (background.js, recheckOnLook).
  void send({ type: "look" });
  // The usage counts' question, or the footer's switch once it is answered.
  void drawUsage();

  /* Refreshed when something changes, never on a timer. The worker says when
     a session starts, ends, fails over or has its login refused; Chrome says
     when another extension takes the proxy setting. */
  chrome.runtime?.onMessage?.addListener((msg) => {
    if (msg?.type === "statusChanged") refreshStatus();
  });
  chrome.proxy?.settings?.onChange?.addListener(() => refreshStatus());
  // The worker saves a proxy that answered late (background.js, keepSaved): the list follows.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.hproxy_byo) renderByoList();
    if (area === "local" && changes.hproxy_last_target) lastTarget = changes.hproxy_last_target.newValue || null;
    if (area === "local" && changes.hproxy_last_own) lastOwn = changes.hproxy_last_own.newValue || null;
  });
}

init();
