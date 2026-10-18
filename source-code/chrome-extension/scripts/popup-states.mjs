/* ============================================================
   popup-states.mjs: every state of the popup, drawn, for a look before a
   release (2026-10-12, the redesign as a proxy connector).

     node scripts/popup-states.mjs <output folder>
     node scripts/popup-states.mjs <output folder> --free   (adds a live free exit)

   Opens the popup of THIS folder's extension in Chrome for Testing (never
   the browser in use: tests/e2e/cdp.mjs) at 2x and captures:

     1  My proxies, not connected, a few example proxies kept
     2  the same, one row pointed at (Connect, its pencil and its ×)
     2e last days (2026-10-15): two named with a note, a plan in its last
        days, one ended, and the line over the list counting them
     2f a row's editor open (name, last day, note)
     2g the list by its soonest last day
     2h a proxy past its last day connecting all the same, and saying so
     3  a proxy pasted and connecting
     4  your own proxy connected (the test proxy on this machine, which
        leaves by this machine's own address, so its checks rightly find a
        leak and open by themselves)
     5  the checks open
     6  Free, and 7 a country pointed at (its star and Connect)
     8a a kept proxy whose login is refused
     8b a kept proxy that does not answer, while it is asked again
     8c the same, later
     8  after the switch disconnected
     8d a first-time user: nothing kept yet
     9, 10 (with --free) the fastest free proxy connecting, then connected

   And it checks, in words on the console: no script error on the page, the
   checks hidden while a proxy does not answer, and the rolling address (its
   digits on a landed wheel stand where the plain text puts them, and it is
   plain text again after the turn).

   Every address on screen is swapped for an example one (RFC 5737 / 3849),
   and the resolver's network name for "A network in <country>", before each
   capture. The folder's copy is loaded unpacked, and such a copy says so; the
   note is hidden in the pictures, the store's copy never shows it.
   ============================================================ */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey, launchWithExtension, navigate, newPage } from "../tests/e2e/cdp.mjs";
import { deadPort, startTestProxy } from "../tests/e2e/test-proxy.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const OUT = resolve(ARGS.find((a) => !a.startsWith("--")) || join(EXT, "dist", "states"));
const FREE = ARGS.includes("--free");
mkdirSync(OUT, { recursive: true });
const ID = extensionIdFromKey(JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")).key);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The example proxies kept in the list: their addresses stay as they are. */
const KEPT = [
  { host: "198.51.100.7", port: 8080, scheme: "http", username: "user", password: "pass", country: "NL" },
  { host: "203.0.113.24", port: 3128, scheme: "http", username: "", password: "", country: "US" },
  { host: "192.0.2.44", port: 1080, scheme: "socks5", username: "", password: "", country: "DE" },
  { host: "198.51.100.23", port: 8000, scheme: "http", username: "user", password: "pass", country: "GB" },
  { host: "203.0.113.9", port: 9050, scheme: "socks5", username: "", password: "", country: "" },
];

const MASK = `(() => {
  const examples = ["203.0.113.24", "198.51.100.7", "192.0.2.61", "203.0.113.130"];
  const keep = new Set(${JSON.stringify(KEPT.map((x) => x.host))});
  const seen = new Map();
  const swap = (s) => s
    .replace(/\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g, (ip) => {
      if (keep.has(ip)) return ip;
      if (!seen.has(ip)) seen.set(ip, examples[seen.size % examples.length]);
      return seen.get(ip);
    })
    .replace(/\\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\\b/gi, "2001:db8::24");
  // An address caught while it turns is a wheel per digit, which no text search matches: plain text first.
  document.querySelectorAll(".digits").forEach((n) => {
    n.textContent = n.dataset.text || n.getAttribute("aria-label") || n.textContent;
    n.classList.remove("digits");
  });
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = swap(n.nodeValue);
  document.querySelectorAll("[title]").forEach((e) => (e.title = swap(e.title)));
  document.querySelectorAll(".arow").forEach((row) => {
    const v = row.querySelector(".arow-value");
    if (row.querySelector(".arow-label")?.textContent.trim() === "DNS resolver" && v && row.dataset.status === "ok") {
      v.textContent = v.textContent.replace(/^.+?, ([A-Z]{2})$/, "A network in $1");
    }
  });
  const hand = document.getElementById("handLoaded");
  if (hand) hand.hidden = true;
  return seen.size;
})()`;

const proxy = await startTestProxy({ user: "demo", pass: "demo-pass" });
const second = await startTestProxy({ user: "demo", pass: "demo-pass" });
const { cdp, close } = await launchWithExtension({ extensionDir: EXT, headless: true, extraArgs: ["--lang=en-US", "--accept-lang=en-US"] });
const errors = [];
try {
  const { sessionId: s } = await newPage(cdp, { width: 400, height: 600 });
  cdp.listeners.add((m) => {
    if (m.sessionId !== s) return;
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 384, height: 600, deviceScaleFactor: 2, mobile: false }, s);
  // A US visitor's browser, so the time zone and language checks judge a setup a reader recognises.
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" }, s);
  const js = (e) => cdp.evaluate(s, e);
  const hover = async (selector) => {
    const box = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    if (!box) throw new Error(`nothing at ${selector}`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y }, s);
    await sleep(250);
  };
  const unhover = () => cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 590 }, s);
  /* Masked first, pointed at after: the mask rewrites the page's words, and a
     row whose words change under a still mouse loses its hover. */
  const capture = async (name, pointAt = null) => {
    await js(MASK);
    await sleep(120);
    if (pointAt) await hover(pointAt);
    await sleep(200);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, s);
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(file);
  };
  const until = async (expression, seconds) => {
    for (let i = 0; i < seconds * 2; i++) {
      if (await js(expression)) return true;
      await sleep(500);
    }
    return false;
  };
  const row = (key) => `document.querySelector('#byoList .row[data-key="${key}"]')`;

  const popup = `chrome-extension://${ID}/popup.html`;
  await navigate(cdp, s, popup, 30_000);
  await js(`chrome.storage.local.set({ hproxy_last_surface: "proxies", hproxy_byo: ${JSON.stringify(KEPT)} })`);
  await navigate(cdp, s, popup, 30_000);
  await sleep(1800);
  await capture("1-proxies");
  await capture("2-proxies-hover", '#byoList .row[data-key="203.0.113.24:3128"]');
  await unhover();

  /* Last days, counted from the page's own today. The toolbar's count is
     read, not drawn (a headless browser has no toolbar). */
  const lastDays = (extra = []) => `(() => {
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return HPROXY_EXPIRY.todayHere(d); };
    const kept = ${JSON.stringify(KEPT)};
    kept[0] = { ...kept[0], name: "Shop account 3", expires: day(24), note: "Thirty-day plan, renewed by hand" };
    kept[1] = { ...kept[1], expires: day(2) };
    kept[3] = { ...kept[3], name: "Streaming UK", expires: day(-5), note: "Ask the seller to extend it" };
    const more = ${JSON.stringify(extra)}.map((x) => ({ ...x, expires: day(x.expires) }));
    return chrome.storage.local.set({ hproxy_byo: [...more, ...kept] });
  })()`;
  await js(lastDays());
  await sleep(700);
  await capture("2e-last-days");
  console.log("toolbar count while not connected:", await js(`chrome.action.getBadgeText({})`));
  await js(`${row("203.0.113.24:3128")}.querySelector(".row-edit").click()`);
  await sleep(300);
  await js(`(() => { const f = document.querySelector('.row-editor [data-field="name"]'); f.value = "Office line"; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  // Its buttons in the picture too: the editor's foot at the window's foot.
  await js(`document.querySelector(".row-editor").scrollIntoView({ block: "end" })`);
  await capture("2f-editor");
  await js(`window.scrollTo(0, 0)`);
  await js(`document.querySelector('.row-editor [data-act="save"]').click()`);
  await sleep(600);
  console.log("saved from the editor:", await js(`${row("203.0.113.24:3128")}.querySelector(".row-name").textContent`));
  await js(`document.getElementById("expirySort").click()`);
  await sleep(300);
  await capture("2g-soonest-first");
  await js(`document.getElementById("expirySort").click()`);
  // The test proxy on this machine as a plan that ended three days ago.
  await js(lastDays([{ host: "127.0.0.1", port: proxy.port, scheme: "http", username: "demo", password: "demo-pass", country: "", name: "Old plan", expires: -3 }]));
  await sleep(600);
  await js(`${row(`127.0.0.1:${proxy.port}`)}.click()`);
  await until(`document.getElementById("conn").dataset.phase === "on"`, 15);
  await sleep(900);
  await capture("2h-ended-connects");
  console.log("said on connecting:", await js(`document.getElementById("byoMsg").textContent`));
  await js(`chrome.runtime.sendMessage({ type: "disconnect" })`);
  await until(`document.getElementById("conn").dataset.phase === "off"`, 10);
  await js(`chrome.storage.local.set({ hproxy_byo: ${JSON.stringify(KEPT)} })`);
  await sleep(600);

  // A proxy of our own, pasted with its login: the test proxy on this machine.
  await js(`(() => { document.getElementById("byoInput").value = "127.0.0.1:${proxy.port}:demo:demo-pass"; document.getElementById("byoConnect").click(); })()`);
  await sleep(700);
  await capture("3-connecting");
  await until(`document.getElementById("conn").dataset.phase === "on" && document.getElementById("analyze").dataset.state === "done"`, 15);
  await sleep(900);
  await capture("4-connected-own");
  console.log("checks:", await js(`document.getElementById("verdictHead").textContent + " | " + document.getElementById("checksCount").textContent + " | opened by itself: " + document.getElementById("checksToggle").getAttribute("aria-expanded")`));

  /* The rolling address: turned to another one and landed at once (the turn
     finished while its wheels still stand), each glyph on a wheel against the
     same glyph of the plain text. */
  const restRects = `(() => { const t = document.getElementById("subIp").firstChild; const out = [];
    for (let i = 0; i < t.length; i++) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1); const b = r.getBoundingClientRect(); out.push([b.left, b.top, b.bottom]); }
    return out; })()`;
  const wheelRects = `(() => { const out = [];
    for (const n of document.getElementById("subIp").children) {
      const t = n.classList.contains("sep") ? n.firstChild : n.querySelector(".strip").children[Number(n.querySelector(".size").textContent)].firstChild;
      const r = document.createRange(); r.selectNodeContents(t); const b = r.getBoundingClientRect(); out.push([b.left, b.top, b.bottom]);
    }
    return out; })()`;
  const address = await js(`document.getElementById("subIp").dataset.text`);
  const other = address.replace(/\d/g, (d) => String((Number(d) + 3) % 10));
  await js(`import("./motion.js").then((m) => { const n = document.getElementById("subIp"); m.rollDigits(n, ${JSON.stringify(other)}); n.querySelectorAll(".strip").forEach((x) => x.getAnimations().forEach((a) => a.finish())); })`);
  const landed = await js(wheelRects);
  const wheels = await js(`document.getElementById("subIp").classList.contains("digits")`);
  await sleep(900);
  const plainAfter = !(await js(`document.getElementById("subIp").classList.contains("digits")`));
  const rest = await js(restRects);
  const worst = Math.max(...rest.map((r, i) => Math.max(...r.map((v, k) => Math.abs(v - landed[i][k])))));
  console.log(`rolling address: wheels while it turns ${wheels}, plain text after ${plainAfter}, ${rest.length} glyphs, a landed wheel at most ${worst.toFixed(2)} px off the plain text`);
  await js(`import("./motion.js").then((m) => m.rollDigits(document.getElementById("subIp"), ${JSON.stringify(address)}))`);
  await sleep(900);

  if ((await js(`document.getElementById("checksToggle").getAttribute("aria-expanded")`)) !== "true") await js(`document.getElementById("checksToggle").click()`);
  await sleep(500);
  await capture("5-checks-open");
  await js(`document.getElementById("checksToggle").click()`);
  await sleep(400);

  await js(`document.querySelector('[data-surface="vpn"]').click()`);
  await sleep(1500);
  await capture("6-free");
  await capture("7-free-hover", "#countryList .row[data-cc]:nth-child(3)");
  await unhover();
  await js(`document.querySelector('[data-surface="proxies"]').click()`);
  await sleep(600);

  // A kept proxy whose login is wrong, and one that never answers.
  const dead = await deadPort();
  await js(`chrome.storage.local.get("hproxy_byo").then((o) => chrome.storage.local.set({ hproxy_byo: [
    { host: "127.0.0.1", port: ${second.port}, scheme: "http", username: "demo", password: "wrong", country: "" },
    { host: "127.0.0.1", port: ${dead}, scheme: "http", username: "", password: "", country: "" },
    ...o.hproxy_byo.filter((x) => x.host !== "127.0.0.1") ] }))`);
  await sleep(600);
  await js(`${row(`127.0.0.1:${second.port}`)}.click()`);
  await until(`${row(`127.0.0.1:${second.port}`)}.classList.contains("is-warn")`, 10);
  await sleep(600);
  await capture("8a-login-refused");
  await js(`${row(`127.0.0.1:${dead}`)}.click()`);
  await sleep(2500);
  await capture("8b-no-answer-waiting");
  await until(`document.getElementById("statusTitle").textContent === "No answer yet"`, 40);
  await capture("8c-no-answer");
  console.log("checks hidden while it does not answer:", await js(`document.getElementById("analyze").hidden`));

  await js(`document.getElementById("connSwitch").click()`);
  await sleep(1200);
  await capture("8-after-disconnect");

  await js(`chrome.storage.local.set({ hproxy_byo: [] })`);
  await sleep(600);
  await capture("8d-first-time");

  if (FREE) {
    await js(`document.querySelector('[data-surface="vpn"]').click()`);
    await sleep(800);
    await js(`document.getElementById("quickBtn").click()`);
    await sleep(900);
    await capture("9-free-connecting");
    if (await until(`document.getElementById("conn").dataset.phase === "on"`, 60)) {
      await until(`document.getElementById("analyze").dataset.state === "done"`, 20);
      await sleep(800);
      await capture("10-free-connected");
      console.log("free exit checks:", await js(`document.getElementById("verdictHead").textContent + " | " + document.getElementById("checksCount").textContent`));
      await js(`chrome.runtime.sendMessage({ type: "disconnect" })`);
    } else console.log("no free exit connected within 60 s");
  }
} finally {
  console.log("script errors on the page:", errors.length ? errors : "none");
  await close();
  await proxy.close();
  await second.close();
}
