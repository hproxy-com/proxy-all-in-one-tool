/* ============================================================
   THE EXTENSION IN A REAL BROWSER, END TO END.

     node tests/e2e/real-browser.mjs [--shots=<dir>] [--only=a,b] [--headful]

   The unit tests (tests/*.test.mjs) cover the parser and the grading.
   This run covers what only a real Chrome can: its proxy engine, the
   407 login handshake, failover on a dead exit, the service worker
   being stopped and woken, and the popup against a live connection.

   What it touches:
     - Chrome for Testing with a throwaway profile, deleted afterwards.
       Never the installed Chrome, never anyone's profile.
     - The live free pool through hproxy.com (/api/vpn/next and the
       echo endpoints), the way any user of the extension does.
     - Two small proxies of our own on 127.0.0.1 (test-proxy.mjs).
   What it never does: report anything to /api/vpn/report (the reporter
   is stubbed in the worker from the first check on), sign in, or buy.

   Exit code 0 when every check passed, 1 otherwise.
   ============================================================ */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachServiceWorker, extensionIdFromKey, launchWithExtension, navigate, newPage } from "./cdp.mjs";
import { deadPort, startTestProxy } from "./test-proxy.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const EXT_ID = extensionIdFromKey(manifest.key);
const ORIGIN = `chrome-extension://${EXT_ID}`;
const POPUP = manifest.action?.default_popup || "popup.html";

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const SHOTS = argv.shots ? resolve(String(argv.shots)) : null;
const ONLY = argv.only ? new Set(String(argv.only).split(",")) : null;

/* A neutral third-party page that names the address it was reached from. */
const TRACE = "https://www.cloudflare.com/cdn-cgi/trace";

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass === null ? "SKIP" : pass ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* This machine's own address appears in some states. It never goes into a
   screenshot or the log in full. */
let realIp = null;
const mask = (s) => (realIp ? String(s).split(realIp).join("<your address>") : String(s));

const { cdp, close } = await launchWithExtension({ extensionDir: EXT, headless: !argv.headful });
const errors = [];
cdp.on((m) => {
  if (m.method === "Runtime.exceptionThrown") {
    errors.push(`${m.sessionId?.slice(0, 6)} ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text}`);
  }
});

let sw = await attachServiceWorker(cdp, EXT_ID);
const inWorker = (expr, ms) => cdp.evaluate(sw.sessionId, expr, ms);

/* The popup's messages go out from an extension page with no script of its
   own, so nothing else runs analyses while failover is being measured. */
const control = await newPage(cdp);
await navigate(cdp, control.sessionId, `${ORIGIN}/tests/e2e/blank.html`);
const send = (msg) => cdp.evaluate(control.sessionId, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`, 90_000);

const browse = await newPage(cdp);
async function traceIp(timeoutMs = 25_000, page = browse) {
  const nav = await navigate(cdp, page.sessionId, TRACE, timeoutMs);
  if (!nav.ok) return { ok: false, error: nav.error };
  const text = await cdp.evaluate(page.sessionId, "document.body ? document.body.innerText : ''");
  const ip = /^ip=(.+)$/m.exec(text || "")?.[1]?.trim();
  return ip ? { ok: true, ip } : { ok: false, error: "no ip= line (a block page?)" };
}
async function proxySetting() {
  return inWorker(`new Promise((r) => chrome.proxy.settings.get({}, (d) => r({ level: d.levelOfControl, value: d.value })))`);
}
async function webrtcPolicy() {
  return inWorker(`new Promise((r) => chrome.privacy.network.webRTCIPHandlingPolicy.get({}, (d) => r(d.value)))`);
}
async function session() {
  return inWorker(`new Promise((r) => chrome.storage.local.get("hproxy_session", (o) => r(o.hproxy_session || null)))`);
}
/* Swap a worker function for a counting stand-in. The original is kept on
   globalThis so restore() puts it back. */
async function stub(name, body) {
  await inWorker(`globalThis.__orig_${name} ??= ${name}; globalThis.__calls_${name} = 0; ${name} = ${body};`);
}
/* Keep a worker function, but count its calls. */
async function countCalls(name) {
  await inWorker(
    `globalThis.__orig_${name} ??= ${name}; globalThis.__calls_${name} = 0; ${name} = async (...a) => { globalThis.__calls_${name}++; return globalThis.__orig_${name}(...a); };`,
  );
}
async function restore(name) {
  await inWorker(`if (globalThis.__orig_${name}) ${name} = globalThis.__orig_${name};`);
}
const calls = (name) => inWorker(`globalThis.__calls_${name} || 0`);
/* The worker keeps the pool batch and the exits that failed in session
   storage. A check that feeds it fake exits starts from an empty memory. */
async function forgetPool() {
  await inWorker(
    `chrome.storage.session.get(null).then((all) => chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith("hproxy_pool:") || k === "hproxy_bad_exits")))`,
  );
}
const deadExits = (port) =>
  JSON.stringify(["127.0.0.2", "127.0.0.3", "127.0.0.4"].map((ip) => ({ ip, port, protocols: ["http"], country_code: "ZZ" })));
const vpnSessionOn = (port, label) =>
  `connectProxy({ scheme: "http", host: "127.0.0.1", port: ${port} }, { mode: "vpn", label: ${JSON.stringify(label)}, exitIp: "127.0.0.1", country: "", vpn: { country: "", protocol: "", recent: [] } })`;
const want = (name) => !ONLY || ONLY.has(name);

async function screenshot(page, file) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  if (realIp) {
    await cdp.evaluate(
      page.sessionId,
      `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n; (n = w.nextNode()); ) n.nodeValue = n.nodeValue.split(${JSON.stringify(realIp)}).join("your address");
        document.querySelectorAll("[title]").forEach((e) => e.title = e.title.split(${JSON.stringify(realIp)}).join("your address")); })()`,
    );
  }
  const height = await cdp.evaluate(page.sessionId, "Math.ceil(document.documentElement.scrollHeight)");
  const { data } = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 384, height: Math.max(200, height), scale: 1 } },
    page.sessionId,
  );
  writeFileSync(join(SHOTS, file), Buffer.from(data, "base64"));
}

/* Open the real popup page in a tab at the popup's width, wait for its
   analyzer, and measure what one opening costs. */
async function openPopup({ waitForAnalysis = true } = {}) {
  const page = await newPage(cdp, { width: 384, height: 600 });
  const remote = [];
  const local = new Map();
  const off = cdp.on((m) => {
    if (m.sessionId !== page.sessionId) return;
    if (m.method === "Network.requestWillBeSent") {
      const u = m.params.request.url;
      if (u.startsWith("chrome-extension://")) local.set(m.params.requestId, u);
      else remote.push(u.replace(/\?.*$/, ""));
    }
  });
  const t0 = Date.now();
  await navigate(cdp, page.sessionId, `${ORIGIN}/${POPUP}`);
  let analysisMs = null;
  if (waitForAnalysis) {
    for (let i = 0; i < 160; i++) {
      const state = await cdp.evaluate(page.sessionId, `document.getElementById("analyze")?.dataset.state || ""`);
      if (state === "done") {
        analysisMs = Date.now() - t0;
        break;
      }
      await sleep(250);
    }
  }
  return { page, remote, local, analysisMs, stop: off };
}

async function closePage(page) {
  await cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
}

try {
  /* ── the extension loads and the worker is healthy ── */
  const version = await inWorker("chrome.runtime.getManifest().version");
  record("loads", version === manifest.version, `v${version}, id ${EXT_ID}`);

  /* Nothing in this run reports to the live pool: not the fake dead exits,
     and not the real ones the searches reject either. */
  await stub("reportDead", `() => { globalThis.__calls_reportDead++; }`);

  const heap0 = await cdp.send("Runtime.getHeapUsage", {}, sw.sessionId);
  record("worker-memory-at-rest", heap0.usedSize < 8e6, `${(heap0.usedSize / 1e6).toFixed(2)} MB used of ${(heap0.totalSize / 1e6).toFixed(2)} MB heap`);

  const before = await traceIp();
  realIp = before.ip || null;
  record("direct-baseline", before.ok, before.ok ? "page loads without a proxy" : before.error);
  record("webrtc-untouched-when-off", (await webrtcPolicy()) === "default", `policy "${await webrtcPolicy()}"`);

  /* ── the popup, nothing connected ── */
  if (want("popup-idle")) {
    const p = await openPopup();
    await screenshot(p.page, "real-popup-proxies-idle.png");
    record(
      "popup-idle",
      p.analysisMs !== null,
      `ready in ${p.analysisMs} ms, ${p.remote.length} request(s) to the network: ${[...new Set(p.remote)].join(", ") || "none"}`,
    );
    /* The VPN tab: 100+ flags. Timed INSIDE the page, in two parts, because
       they have different causes: when the country list arrives (network,
       first open of a browser session only; later opens show the kept list)
       and how long the tab takes to draw once clicked (flags, layout).
       Polling from here instead measured the network and called it drawing. */
    const timing = await cdp.evaluate(
      p.page.sessionId,
      `new Promise((resolve) => {
        const start = performance.timeOrigin;
        const waitList = () => {
          const imgs = document.querySelectorAll("#countryList img.flag");
          if (imgs.length > 20) return clickAndTime(Math.round(performance.now()));
          if (performance.now() > 15000) return resolve({ listMs: null });
          requestAnimationFrame(waitList);
        };
        const clickAndTime = (listMs) => {
          const t0 = performance.now();
          document.querySelector('[data-surface="vpn"]').click();
          const tick = () => {
            const imgs = [...document.querySelectorAll("#countryList img.flag")];
            const drawn = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
            if (drawn === imgs.length) resolve({ listMs, drawMs: Math.round(performance.now() - t0), flags: imgs.length });
            else if (performance.now() - t0 > 8000) resolve({ listMs, drawMs: null, flags: drawn, broken: imgs.length - drawn });
            else requestAnimationFrame(tick);
          };
          tick();
        };
        waitList();
      })`,
    );
    await sleep(400); // the row entrance animation, for the picture
    await screenshot(p.page, "real-popup-vpn-idle.png");
    record(
      "popup-vpn-tab",
      timing.drawMs !== null && timing.drawMs < 200,
      `country list arrived ${timing.listMs} ms after opening (network, first open of the session); ${timing.flags} flags drawn ${timing.drawMs} ms after the click${timing.broken ? `, ${timing.broken} broken` : ""}`,
    );
    p.stop();
    await closePage(p.page);
  }

  /* ── the free pool, for real ── */
  let exitBefore = null;
  if (want("free-connect")) {
    const t = Date.now();
    let r = await send({ type: "vpnConnect", country: "", protocol: "" });
    let attempts = 1;
    const tried = [];
    let got = r?.ok ? await traceIp(20_000) : { ok: false, error: r?.error };
    tried.push(`${r?.active?.scheme}://${r?.active?.exitIp} ${got.ok ? "ok" : got.error}`);
    while (!(got.ok && got.ip !== realIp) && attempts < 6) {
      attempts++;
      r = await send({ type: "vpnNewIp" });
      got = r?.ok ? await traceIp(20_000) : { ok: false, error: r?.error };
      tried.push(`${r?.active?.scheme}://${r?.active?.exitIp} ${got.ok ? "ok" : got.error}`);
    }
    console.log(`      exits tried: ${tried.map(mask).join(" | ")}`);
    const s = await send({ type: "status" });
    exitBefore = s?.active?.exitIp;
    const setting = await proxySetting();
    record(
      "free-connect",
      got.ok && got.ip !== realIp,
      got.ok
        ? `through ${s?.active?.scheme} exit ${exitBefore} (${s?.active?.country}), site saw ${mask(got.ip)}; ${attempts} exit(s) tried, ${Date.now() - t} ms; Chrome's proxy: ${setting.level}`
        : `no working exit after ${attempts} tries: ${mask(got.error)}`,
    );
    record("webrtc-locked-while-connected", (await webrtcPolicy()) === "disable_non_proxied_udp", `policy "${await webrtcPolicy()}"`);

    if (want("popup-connected")) {
      const p = await openPopup();
      const verdict = await cdp.evaluate(p.page.sessionId, `document.getElementById("verdictHead")?.textContent + " / " + document.getElementById("verdictSub")?.textContent`);
      const rows = await cdp.evaluate(
        p.page.sessionId,
        `[...document.querySelectorAll("#analyzeList .arow")].map((r) => r.dataset.status + ":" + r.querySelector(".arow-label")?.textContent).join(", ")`,
      );
      await screenshot(p.page, "real-popup-connected-free.png");
      record(
        "popup-connected",
        p.analysisMs !== null,
        `analysis in ${p.analysisMs} ms, ${p.remote.length} network request(s); verdict "${mask(verdict)}"; rows ${rows}`,
      );
      p.stop();
      await closePage(p.page);
    }

    if (want("new-ip")) {
      const r2 = await send({ type: "vpnNewIp" });
      const after = r2?.active?.exitIp;
      const page = await traceIp(20_000);
      // Either a new exit, or the honest "nothing else passed, still on X".
      // Never a broken connection.
      record(
        "new-ip",
        page.ok && !!after && (after !== exitBefore || !!r2?.active?.note),
        `${exitBefore} -> ${after}${r2?.active?.note ? ` (${r2.active.note})` : ""}; a page then ${page.ok ? "loaded" : `failed: ${mask(page.error)}`}`,
      );
    }
  }

  const DEAD = await deadPort();

  /* ── failover heals a dead exit ── */
  if (want("failover-heals")) {
    await inWorker(vpnSessionOn(DEAD, "dead test exit"));
    const t = Date.now();
    const first = await navigate(cdp, browse.sessionId, TRACE, 15_000);
    let moved = null;
    for (let i = 0; i < 60 && !moved; i++) {
      const s = await session();
      if (s && s.proxy && s.proxy.host !== "127.0.0.1") moved = s.proxy.host;
      else await sleep(500);
    }
    const healedIn = Date.now() - t;
    let got = { ok: false };
    for (let i = 0; i < 4 && moved && !got.ok; i++) {
      got = await traceIp(20_000);
      if (!got.ok) await sleep(2_500);
    }
    record(
      "failover-heals",
      !!moved && got.ok,
      `dead exit gave "${first.error || "loaded?"}"; moved to ${moved} after ${healedIn} ms; page then ${got.ok ? "loaded" : `failed (${mask(got.error)})`}`,
    );
    await send({ type: "disconnect" });
  }

  /* ── failover gives up in a total outage ── */
  if (want("failover-cap")) {
    await forgetPool();
    await stub("fetchPool", `async () => { globalThis.__calls_fetchPool++; return ${deadExits(DEAD)}; }`);
    await countCalls("findWorkingExit");
    await inWorker(vpnSessionOn(DEAD, "dead test exit"));
    const until = Date.now() + 26_000;
    let navs = 0;
    while (Date.now() < until) {
      await navigate(cdp, browse.sessionId, `${TRACE}?n=${navs++}`, 4_000);
      await sleep(2_000);
    }
    const rounds = await calls("findWorkingExit");
    const s = await send({ type: "status" });
    record(
      "failover-cap",
      rounds <= 3 && !!s?.active?.failing,
      `${navs} failing page loads in 26 s caused ${rounds} search round(s) (the cap is 3); badge amber (failing): ${!!s?.active?.failing}`,
    );
    await restore("findWorkingExit");
    await restore("fetchPool");
    await forgetPool();
    await send({ type: "disconnect" });
  }

  /* ── one refused site does not throw away a working exit ── */
  if (want("blocked-site-keeps-exit")) {
    const picky = await startTestProxy({ refuse: ["blocked.invalid"] });
    await countCalls("findWorkingExit");
    await inWorker(vpnSessionOn(picky.port, "picky test exit"));
    const ok = await traceIp(15_000);
    const refused = await navigate(cdp, browse.sessionId, "https://blocked.invalid/", 10_000);
    await sleep(6_000);
    const rounds = await calls("findWorkingExit");
    const s = await session();
    record(
      "blocked-site-keeps-exit",
      ok.ok && rounds === 0 && s?.proxy?.port === picky.port,
      `working exit loaded a page: ${ok.ok}; one refused site ("${refused.error}") started ${rounds} search(es); still on the same exit: ${s?.proxy?.port === picky.port}`,
    );
    await restore("findWorkingExit");
    await send({ type: "disconnect" });
    await picky.close();
  }

  /* ── a free exit that wants a login is skipped, not shown as a login box ── */
  if (want("free-exit-wants-login")) {
    const locked = await startTestProxy({ user: "someone", pass: "else" });
    await forgetPool();
    await stub("fetchPool", `async () => { globalThis.__calls_fetchPool++; return []; }`);
    await countCalls("findWorkingExit");
    await inWorker(vpnSessionOn(locked.port, "locked test exit"));
    const page = await newPage(cdp);
    const t = Date.now();
    const nav = await navigate(cdp, page.sessionId, TRACE, 12_000);
    await sleep(4_000);
    const rounds = await calls("findWorkingExit");
    record(
      "free-exit-wants-login",
      rounds >= 1 && Date.now() - t < 12_000 + 4_500,
      `page ${nav.ok ? "loaded" : `"${nav.error}"`} after ${Date.now() - t - 4_000} ms; searches for another exit: ${rounds} (0 = the browser was left waiting on a login prompt)`,
    );
    await closePage(page);
    await restore("findWorkingExit");
    await restore("fetchPool");
    await send({ type: "disconnect" });
    await locked.close();
  }

  /* ── a paid proxy's login ── */
  const good = await startTestProxy({ user: "hpx-user", pass: "right:pass@1" });
  if (want("login-accepted")) {
    const r = await send({ type: "pinConnect", proxy: { scheme: "http", host: "127.0.0.1", port: good.port, username: "hpx-user", password: "right:pass@1" }, label: "test paid proxy" });
    const got = await traceIp(15_000);
    record(
      "login-accepted",
      r?.ok && got.ok && good.stats.challenges >= 1 && good.stats.accepted >= 1,
      `connect ok=${r?.ok}; page ${got.ok ? "loaded" : mask(got.error)}; the proxy asked ${good.stats.challenges}x and accepted ${good.stats.accepted}x`,
    );
    const pub = await send({ type: "status" });
    record("password-never-leaves-the-worker", !JSON.stringify(pub).includes("right:pass@1"), "status answer carries no password");
  }

  if (want("login-refused")) {
    const strict = await startTestProxy({ user: "hpx-user", pass: "right" });
    await send({ type: "pinConnect", proxy: { scheme: "http", host: "127.0.0.1", port: strict.port, username: "hpx-user", password: "WRONG" }, label: "wrong password" });
    const got = await traceIp(15_000);
    await sleep(500);
    const s = await send({ type: "status" });
    record(
      "login-refused",
      !got.ok && s?.active?.loginRefused === true && strict.stats.challenges <= 4,
      `page ${got.ok ? "loaded?!" : "refused"}; popup state loginRefused=${s?.active?.loginRefused}; the proxy was asked ${strict.stats.challenges}x (a loop would be dozens)`,
    );
    await send({ type: "disconnect" });
    await strict.close();
  }

  /* ── "Connect a proxy" tests the person's own proxy IN this browser
        (pinFind): the line and its login never leave it, only the probe
        goes through the proxy, and their pages do not move until it passes ── */
  if (want("pin-test")) {
    /* A proxy with a login: found over HTTP, the login answered by the worker,
       nothing connected. A fresh proxy on purpose: Chrome keeps an HTTP/2
       connection to probe.hproxy.com open per proxy and reuses it, so a proxy
       an earlier check already used would carry the probe without being asked
       for the login again. */
    const fresh = await startTestProxy({ user: "pin-user", pass: "pin:pass@2" });
    const t = Date.now();
    const found = await send({ type: "pinFind", proxy: { host: "127.0.0.1", port: fresh.port, username: "pin-user", password: "pin:pass@2" }, schemes: ["http", "socks5"] });
    const after = await send({ type: "status" });
    const setting = await proxySetting();
    record(
      "pin-test-finds-http",
      found?.ok && found.found?.scheme === "http" && !!found.found?.exitIp && fresh.stats.challenges >= 1 && fresh.stats.accepted >= 1 && !after?.active && setting.level !== "controlled_by_this_extension",
      `answer ${JSON.stringify(found?.found ? { scheme: found.found.scheme, exit: found.found.exitIp ? "seen" : "none" } : found)} in ${Date.now() - t} ms; the proxy asked for the login ${fresh.stats.challenges}x and accepted it ${fresh.stats.accepted}x; afterwards connected: ${!!after?.active}, Chrome's proxy: ${setting.level}`,
    );
    await fresh.close();

    // The wrong password: said before anything connects, asked only a few times.
    const strict = await startTestProxy({ user: "hpx-user", pass: "right" });
    const refused = await send({ type: "pinFind", proxy: { host: "127.0.0.1", port: strict.port, username: "hpx-user", password: "WRONG" }, schemes: ["http", "socks5"] });
    const s2 = await send({ type: "status" });
    record(
      "pin-test-login-refused",
      refused?.ok && refused.found?.loginRefused === true && !s2?.active && strict.stats.challenges <= 4,
      `answer ${JSON.stringify(refused?.found)}; connected afterwards: ${!!s2?.active}; the proxy was asked ${strict.stats.challenges}x`,
    );
    await strict.close();

    // Nothing listening: no answer on any protocol, quickly.
    const port = await deadPort();
    const t3 = Date.now();
    const dead = await send({ type: "pinFind", proxy: { host: "127.0.0.1", port }, schemes: ["socks5", "http", "socks4"] });
    record(
      "pin-test-dead-port",
      dead?.ok && dead.found === null && Date.now() - t3 < 20_000,
      `answer ${JSON.stringify(dead?.found)} after ${Date.now() - t3} ms for 3 protocols`,
    );

    // Connected to one proxy while another is tested: the connection stays.
    await send({ type: "pinConnect", proxy: { scheme: "http", host: "127.0.0.1", port: good.port, username: "hpx-user", password: "right:pass@1" }, label: "test paid proxy" });
    const other = await startTestProxy();
    const tested = await send({ type: "pinFind", proxy: { host: "127.0.0.1", port: other.port }, schemes: ["socks5", "http"] });
    const kept = await proxySetting();
    const stillOn = await send({ type: "status" });
    const page = await traceIp(15_000);
    record(
      "pin-test-keeps-current",
      tested?.ok && tested.found?.scheme === "http" && kept.value?.rules?.singleProxy?.port === good.port && stillOn?.active?.port === good.port && page.ok,
      `second proxy found over ${tested?.found?.scheme}; Chrome still on port ${kept.value?.rules?.singleProxy?.port} (the connected one is ${good.port}); a page loads: ${page.ok}`,
    );
    await other.close();
    await send({ type: "disconnect" });
  }

  /* ── the worker is stopped (Chrome does this after 30 s idle) and a
        request needing the login wakes it ── */
  if (want("login-after-worker-restart")) {
    const cold = await startTestProxy({ user: "cold", pass: "start" });
    await send({ type: "pinConnect", proxy: { scheme: "http", host: "127.0.0.1", port: cold.port, username: "cold", password: "start" }, label: "cold start" });
    let stopped = false;
    try {
      await cdp.send("ServiceWorker.enable", {}, control.sessionId);
      await cdp.send("ServiceWorker.stopAllWorkers", {}, control.sessionId);
      stopped = true;
    } catch (e) {
      record("login-after-worker-restart", null, `could not stop the worker from DevTools: ${e.message}`);
    }
    if (stopped) {
      await sleep(1_000);
      // Chrome cached the login when the connect tested the proxy; a new
      // realm makes the next 407 go to the (stopped) worker again.
      cold.rechallenge();
      const asked = cold.stats.challenges;
      const got = await traceIp(20_000);
      const woke = await attachServiceWorker(cdp, EXT_ID, 3_000).catch(() => null);
      if (woke) sw = woke;
      else {
        await send({ type: "status" }); // wakes it, for the checks that follow
        sw = await attachServiceWorker(cdp, EXT_ID);
      }
      // A fresh worker: the reporter stub went with the old one.
      await stub("reportDead", `() => { globalThis.__calls_reportDead++; }`);
      record(
        "login-after-worker-restart",
        got.ok && cold.stats.challenges > asked && !!woke,
        `a 407 reached the stopped worker: ${cold.stats.challenges > asked}; it woke and answered: ${!!woke}; page ${got.ok ? "loaded" : mask(got.error)}`,
      );
    }
    await send({ type: "disconnect" });
    await cold.close();
  }

  /* ── the badge never says connected while traffic goes direct ── */
  if (want("no-false-connected")) {
    await send({ type: "pinConnect", proxy: { scheme: "http", host: "127.0.0.1", port: good.port, username: "hpx-user", password: "right:pass@1" }, label: "test paid proxy" });
    // Our setting disappears behind the extension's back (disable + enable,
    // a crash): the stored session still says connected.
    await inWorker(`new Promise((r) => chrome.proxy.settings.clear({ scope: "regular" }, r))`);
    const s = await send({ type: "status" });
    const setting = await proxySetting();
    const inEffect = setting.level === "controlled_by_this_extension" && setting.value?.rules?.singleProxy?.port === good.port;
    const claimsConnected = !!s?.active && !s.active.hijacked && !s.active.failing;
    record(
      "no-false-connected",
      !claimsConnected || inEffect,
      `popup would say ${claimsConnected ? '"Connected"' : s?.active ? "a warning" : '"Not connected"'}; our proxy setting in effect: ${inEffect} (${setting.level})`,
    );
    await send({ type: "disconnect" });
  }

  /* ── a host typed in mixed case is still ours ── */
  if (want("mixed-case-host")) {
    // Chrome hands the host back lower-cased; compared raw it read as
    // "another extension is in control".
    await send({ type: "pinConnect", proxy: { scheme: "http", host: "LocalHost", port: good.port, username: "hpx-user", password: "right:pass@1" }, label: "mixed case" });
    const s = await send({ type: "status" });
    const setting = await proxySetting();
    record(
      "mixed-case-host",
      !!s?.active && !s.active.hijacked && setting.level === "controlled_by_this_extension",
      `connected to "LocalHost"; Chrome reports host "${setting.value?.rules?.singleProxy?.host}"; popup says ${s?.active?.hijacked ? '"Another extension is in control"' : "connected"}`,
    );
    await send({ type: "disconnect" });
  }

  /* ── disconnect puts everything back ── */
  if (want("disconnect")) {
    await send({ type: "pinConnect", proxy: { scheme: "http", host: "127.0.0.1", port: good.port, username: "hpx-user", password: "right:pass@1" }, label: "test paid proxy" });
    const lockedWhileOn = await webrtcPolicy();
    await send({ type: "disconnect" });
    const setting = await proxySetting();
    const got = await traceIp(15_000);
    const policy = await webrtcPolicy();
    record(
      "disconnect-restores-everything",
      setting.level !== "controlled_by_this_extension" && got.ok && got.ip === realIp && policy === "default",
      `Chrome's proxy: ${setting.level}; page loads direct: ${got.ok && got.ip === realIp}; WebRTC "${lockedWhileOn}" while on, "${policy}" after`,
    );
  }
  await good.close();

  await restore("reportDead");
  const heap1 = await cdp.send("Runtime.getHeapUsage", {}, sw.sessionId);
  record("worker-memory-after-run", heap1.usedSize < 8e6, `${(heap1.usedSize / 1e6).toFixed(2)} MB used`);
  record("no-script-errors", errors.length === 0, errors.length ? mask(errors.slice(0, 5).join(" | ")) : "none in the worker or any page");
} catch (e) {
  record("run", false, mask(e.stack || e.message));
} finally {
  await close();
}

const failed = results.filter((r) => r.pass === false);
console.log(`\n${results.filter((r) => r.pass).length} passed, ${failed.length} failed, ${results.filter((r) => r.pass === null).length} skipped`);
process.exitCode = failed.length ? 1 : 0;
