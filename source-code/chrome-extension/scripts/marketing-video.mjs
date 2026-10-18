/* ============================================================
   marketing-video.mjs: a short film of the popup at work, for the website.

     node scripts/marketing-video.mjs [--frames <folder>]

   What it shows, as the popup does it: the H in the toolbar pressed, the popup opens; one of
   your proxies pressed, the top floods blue, the badge says ON; the checks opened, all seven
   clear; Free, the countries, the United States pressed, on again through a free proxy; the
   power button, off; the popup closed by a click beside it. On the left the words of what
   happens, as on the store's pictures. The recording starts and ends with the popup closed, so
   the last frame is the first and the film loops without a seam; it opens connected, the
   poster too.

   How it is made:
   · The real popup of THIS folder in Chrome for Testing (never the browser in use:
     tests/e2e/cdp.mjs), in a frame of scripts/film/film.html. Only a page of the extension's
     own may frame its popup, so the folder is copied, the stage put beside popup.html, and the
     copy loaded: without its worker, as film.js plays the worker (a connect takes 1.2 s, a free
     one 1.6 s), and a worker of its own would clear the WebRTC lock whenever it starts.
   · The clock of the app's film (desktop-app/scripts/film.mjs) in the stage and the popup,
     moved 40 ms a frame; a pointer drawn on the stage, and real mouse events under it.
   · Every request the popup makes is answered here, a few frames later on the film's clock:
     the checks (your address, the exit, the DNS test, three round trips) with addresses from the
     ranges set aside for examples (RFC 5737), and the countries' counts as hproxy.com gives them
     at the start of the run. Any other request fails and is reported.
   · New York's clock and the language en-US, as a US exit has them, and WebRTC locked to the
     proxy, as the worker locks it on connect: so all seven checks pass, as they do through a
     good proxy.
   Output: store/marketing/extension-in-action.mp4 (1280 x 720) and .webp, its poster. The
   script fails on any page error, on a check that does not pass, and on a seam.
   ============================================================ */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOCK, writeFilm } from "../../desktop-app/scripts/film.mjs";
import { extensionIdFromKey, launchWithExtension, navigate, newPage } from "../tests/e2e/cdp.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(EXT, "store", "marketing");
const W = 1280;
const H = 720;
const FPS = 25;
const STEP = 1000 / FPS;
// H.264 quantizers, as the app's film: the sharp one where little changed, up to the coarse one
// where most of the picture moved.
const SHARP = 24;
const MOVING = 34;
const framesArg = process.argv.indexOf("--frames");
const FRAMES = framesArg > 0 ? process.argv[framesArg + 1] : null;

// This browser without a proxy, your proxy's exit, the free exit (film.js, FREE) and the
// resolver the DNS test sees.
const OWN = "198.51.100.200";
const YOURS = "203.0.113.24";
const FREE = "192.0.2.148";
const RESOLVER = "198.51.100.53";
// Your proxies as the popup keeps them (hproxy_byo), the first the one the film connects.
const SAVED = [
  { host: YOURS, port: 8000, scheme: "socks5", country: "US" },
  { host: "198.51.100.7", port: 8080, scheme: "http", country: "NL", username: "user", password: "pass" },
  { host: "192.0.2.61", port: 1080, scheme: "socks5", country: "DE" },
  { host: "203.0.113.130", port: 8000, scheme: "http", country: "GB", username: "user", password: "pass" },
].map((p) => ({ ...p, label: `${p.host}:${p.port}` }));

/* In the popup's frame, before its own code: its messages go to film.js's worker, and the line
   a copy loaded by hand shows (the store's copy never does) stays hidden. */
const POPUP = String.raw`(() => {
  if (window.top === window || !globalThis.chrome?.runtime) return;
  const worker = window.top.__worker;
  if (!worker) return;
  chrome.runtime.sendMessage = (msg, cb) => worker.handle(msg, cb);
  chrome.runtime.onMessage.addListener = (fn) => worker.listen(fn);
  addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = "#handLoaded{display:none!important} *{caret-color:transparent!important}";
    document.head.append(style);
  });
})();`;

// The countries' counts as the free pool has them now: the only answer read from hproxy.com.
const live = await (await fetch("https://hproxy.com/api/vpn/countries", { headers: { Accept: "application/json" } })).json();
const COUNTRIES = { countries: (live.countries || []).filter((c) => /^[A-Za-z]{2}$/.test(c.country_code || "")) };
if (!COUNTRIES.countries.some((c) => c.country_code.toUpperCase() === "US")) throw new Error("the free pool lists no United States");

// The copy: the folder without what the popup never loads, the stage beside popup.html, no worker.
const COPY = mkdtempSync(join(tmpdir(), "hproxy-film-"));
const SKIP = new Set(["dist", "research", "scripts", "store", "tests", "node_modules", ".git"]);
cpSync(EXT, COPY, { recursive: true, filter: (src) => !SKIP.has(relative(EXT, src).split(/[\\/]/)[0]) });
for (const f of ["film.html", "film.css", "film.js"]) cpSync(join(EXT, "scripts", "film", f), join(COPY, f));
const manifest = JSON.parse(readFileSync(join(COPY, "manifest.json"), "utf8"));
delete manifest.background;
writeFileSync(join(COPY, "manifest.json"), JSON.stringify(manifest, null, 2));
const ID = extensionIdFromKey(manifest.key);

mkdirSync(OUT, { recursive: true });
if (FRAMES) mkdirSync(FRAMES, { recursive: true });
const { cdp, close } = await launchWithExtension({ extensionDir: COPY, headless: true, extraArgs: ["--lang=en-US", "--accept-lang=en-US"] });
const problems = [];
const shots = []; // every frame, a PNG in base64
let start = 0; // where the film begins: connected through your proxy
try {
  const page = await newPage(cdp, { width: W, height: H });
  const s = page.sessionId;
  cdp.on((m) => {
    if (m.sessionId === s && m.method === "Runtime.exceptionThrown") problems.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  });
  const js = (e) => cdp.evaluate(s, e);

  /* The network. A request is answered `after` frames on the film's clock, so the checks come in
     one by one as they do, and the round trip they measure is the film's. */
  let frames = 0;
  let exitNow = YOURS;
  let probes = 0;
  const waiting = [];
  const json = (o) => ({ code: 200, type: "application/json", body: JSON.stringify(o) });
  const answerFor = (url) => {
    const u = new URL(url);
    if (u.protocol === "chrome-extension:" || u.protocol === "data:") return "continue";
    const host = u.hostname;
    const path = u.pathname;
    if (host === "hproxy.com" && path === "/api/vpn/countries") return { after: 3, ...json(COUNTRIES) };
    if (host === "hproxy.com" && path === "/api/free-proxy/echo") return { after: 4, ...json({ peer_ip: OWN }) };
    // Through the proxy: the exit; three of them are the round trips (5, 6 and 5 frames).
    if (host === "probe.hproxy.com" && path === "/api/free-proxy/echo") return { after: 5 + (probes++ % 3 === 1 ? 1 : 0), ...json({ peer_ip: exitNow }) };
    if (host === "hproxy.com" && path.startsWith("/api/ip/")) {
      const ip = decodeURIComponent(path.slice("/api/ip/".length));
      // The store's pictures say the resolver's network so: no hosting company is named.
      const geo = ip === RESOLVER ? { ip, asn_org: "A network in US" } : { ip, country: "US", country_name: "United States", asn_org: "A hosting network", asn: 64500, is_datacenter: false };
      return { after: 2, ...json(geo) };
    }
    if (host.endsWith(".leak.hproxy.com")) return { after: 3, code: 204, type: "text/plain", body: "" };
    if (host === "hproxy.com" && path.startsWith("/api/leak/")) return { after: 2, ...json({ seen: true, resolvers: [{ ip: RESOLVER }] }) };
    return null;
  };
  cdp.on((m) => {
    if (m.sessionId !== s || m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    // A request left paused would hold the page's painting (a style sheet, a font): never.
    let a = null;
    try {
      a = answerFor(request.url);
    } catch (e) {
      problems.push(`could not read the request ${request.url}: ${e.message}`);
    }
    if (a === "continue") return void cdp.send("Fetch.continueRequest", { requestId }, s).catch(() => {});
    if (!a) {
      problems.push(`the popup asked for ${request.url}, which the film does not answer`);
      return void cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, s).catch(() => {});
    }
    waiting.push({ requestId, due: frames + a.after, a });
  });
  const answerDue = async () => {
    const due = waiting.filter((w) => w.due <= frames);
    if (!due.length) return;
    for (const w of due) {
      waiting.splice(waiting.indexOf(w), 1);
      await cdp.send(
        "Fetch.fulfillRequest",
        {
          requestId: w.requestId,
          responseCode: w.a.code,
          responseHeaders: [
            { name: "Content-Type", value: w.a.type },
            { name: "Access-Control-Allow-Origin", value: "*" },
            { name: "Cache-Control", value: "no-store" },
          ],
          body: Buffer.from(w.a.body).toString("base64"),
        },
        s,
      );
    }
    // The page takes the answers in before the clock moves on.
    await new Promise((r) => setTimeout(r, 40));
  };

  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" }, s);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK }, s);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: POPUP }, s);
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, s);
  const stage = `chrome-extension://${ID}/film.html`;
  if (!(await navigate(cdp, s, stage, 30_000)).ok) throw new Error(`the stage did not load: ${stage}`);

  // Your proxies kept, the first one the place the button goes to, My proxies open, WebRTC locked.
  await js(`(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    await chrome.storage.local.set({
      hproxy_byo: ${JSON.stringify(SAVED)},
      hproxy_last_target: { kind: "pin", key: ${JSON.stringify(`${YOURS}:8000`)} },
      hproxy_last_surface: "proxies",
    });
    await new Promise((r) => chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: "disable_non_proxied_udp" }, r));
    await document.fonts.ready;
    __stage.say(0, true);
  })()`);
  await js(`__stage.load()`);

  const REST = { x: 760, y: 600 };
  let at = { ...REST };
  let pressed = false;
  let ring = null;
  // Off camera, every step moves the clock and nothing is kept.
  let rolling = false;
  const draw = () => {
    let r = 0;
    let a = 0;
    if (ring) {
      const k = ring.k / 9;
      r = 9 + 21 * k;
      a = Math.max(0, 1 - k);
      if (++ring.k > 9) ring = null;
    }
    return js(`__stage.pointer(${at.x}, ${at.y}, ${pressed}, ${r}, ${a})`);
  };
  // One capture, asked again once: Chrome has left a capture unanswered (the first run, once).
  const capture = async () => {
    try {
      return (await cdp.send("Page.captureScreenshot", { format: "png" }, s, 20_000)).data;
    } catch {
      return (await cdp.send("Page.captureScreenshot", { format: "png" }, s, 20_000)).data;
    }
  };
  const frame = async () => {
    await draw();
    await js(`__stage.step(${STEP})`);
    frames++;
    await answerDue();
    if (rolling) shots.push(await capture());
  };
  const hold = async (ms) => {
    for (let i = 0; i < Math.round(ms / STEP); i++) await frame();
  };
  const holdUntil = async (test, what, max = 8000) => {
    for (let t = 0; !(await js(test)); t += STEP) {
      if (t > max) throw new Error(`waited ${max} ms for ${what}`);
      await frame();
    }
  };
  const mouse = (type, extra = {}) => cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", ...extra }, s);
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const glide = async (to, ms) => {
    const from = { ...at };
    const n = Math.round(ms / STEP);
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      at = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
      await mouse("mouseMoved");
      await frame();
    }
  };
  // A press and its release two frames later; `then` runs at the release (a toolbar button
  // acts on it, as the page's own buttons do on their click).
  const click = async (then) => {
    pressed = true;
    await mouse("mousePressed", { clickCount: 1 });
    await frame();
    await frame();
    await mouse("mouseReleased", { clickCount: 1 });
    pressed = false;
    ring = { k: 0 };
    if (then) await then();
  };
  const spot = async (sel) => {
    const r = await js(`__stage.inPopup(${JSON.stringify(sel)})`);
    if (!r) throw new Error(`not in the popup: ${sel}`);
    if (r.top < 104 || r.bottom > 704) throw new Error(`out of the popup's view: ${sel} (${Math.round(r.top)} to ${Math.round(r.bottom)})`);
    return { x: Math.round(r.x), y: Math.round(r.y) };
  };
  const popupAttr = (sel, name) => `__stage.popupAttr(${JSON.stringify(sel)}, ${JSON.stringify(name)})`;
  const settled = `(${popupAttr("#analyze", "data-state")} === "done")`;
  const allClear = async (what) => {
    const verdict = await js(`__stage.popupText("#verdictHead")`);
    if (verdict !== "Everything checks out") {
      const rows = await js(`[...document.getElementById("popup").contentDocument.querySelectorAll(".arow")].map((r) => r.dataset.status + " " + r.textContent.trim()).join(" | ")`);
      throw new Error(`${what}: the checks say "${verdict}" (${rows})`);
    }
  };
  const EXT_BUTTON = await js(`(() => { const b = document.getElementById("ext").getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);

  // Off camera: the popup's page settles closed (its saved proxies drawn, the countries read),
  // and one capture is taken, so the page has painted once before the first that counts.
  await draw();
  await mouse("mouseMoved");
  await hold(1600);
  await capture();
  if (!(await js(`!!__stage.inPopup('#byoList .row[data-key="${YOURS}:8000"]')`))) throw new Error("the popup did not draw your proxies");

  // The film. Its first frame is the pointer at rest, as its last one is.
  rolling = true;
  await hold(STEP);
  await hold(500);
  await glide(EXT_BUTTON, 760);
  await hold(100);
  await click(() => js(`__stage.open(true)`));
  await hold(800);
  exitNow = YOURS;
  await glide(await spot(`#byoList .row[data-key="${YOURS}:8000"]`), 720);
  await hold(160);
  await click();
  // The hand moves off while it connects, beside the popup, where it covers nothing.
  await hold(120);
  await glide({ x: 1258, y: 430 }, 640);
  await holdUntil(`!!__stage.state.active && __stage.state.active.verified === true && !__stage.state.testing`, "your proxy");
  await js(`__stage.say(1)`);
  await holdUntil(settled, "the checks of your proxy");
  await allClear("your proxy");
  await hold(1400);
  start = shots.length;
  await hold(500);
  await glide(await spot("#checksToggle"), 600);
  await hold(100);
  await click();
  await js(`__stage.say(2)`);
  await hold(2300);
  await click();
  await hold(500);
  await glide(await spot('#surfaces .tab[data-surface="vpn"]'), 620);
  await hold(80);
  await click();
  await js(`__stage.say(3)`);
  await hold(1300);
  exitNow = FREE;
  await glide(await spot('#countryList .row[data-cc="US"]'), 700);
  await hold(140);
  await click();
  await holdUntil(`!!__stage.state.active && __stage.state.active.mode === "vpn" && !__stage.state.searching`, "the free proxy");
  await js(`__stage.say(4)`);
  await holdUntil(settled, "the checks of the free proxy");
  await allClear("the free proxy");
  await hold(1500);
  await glide(await spot("#connSwitch"), 700);
  await hold(120);
  await click();
  await holdUntil(`!__stage.state.active`, "the disconnection");
  await js(`__stage.say(0)`);
  await hold(1300);
  // A click beside the popup closes it, as in Chrome.
  await glide(REST, 760);
  await hold(80);
  await click(() => js(`__stage.open(false)`));
  await hold(560);

  const errors = await js(`__stage.errors()`);
  if (errors.length) problems.push(...errors);

  // The loop turned round to open connected through your proxy. The encoder's page is the
  // extension's own: WebCodecs needs a secure page, and an extension's is one.
  const said = await writeFilm(cdp, {
    coderUrl: `chrome-extension://${ID}/tokens.css`,
    shots,
    start,
    width: W,
    height: H,
    fps: FPS,
    sharp: SHARP,
    moving: MOVING,
    mp4File: join(OUT, "extension-in-action.mp4"),
    posterFile: join(OUT, "extension-in-action.webp"),
    framesDir: FRAMES,
    problems,
  });
  console.log(`extension-in-action.mp4: ${said}`);
} finally {
  await close();
  rmSync(COPY, { recursive: true, force: true });
}
if (problems.length) {
  console.error(`PROBLEMS:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log("no page errors");
}
