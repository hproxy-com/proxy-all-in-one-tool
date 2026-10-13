/* ============================================================
   store-shots.mjs: the Chrome Web Store pictures, from the real popup.

     node scripts/store-shots.mjs <output folder>
     node scripts/store-shots.mjs <output folder> --only=promo   (the promo tile alone)

   Opens the popup of THIS folder's extension in Chrome for Testing (never
   the installed Chrome: tests/e2e/cdp.mjs) with a few example proxies
   saved, captures Free, then takes a tested exit from the live free pool,
   keeps it as one of "My proxies" and connects it from its row, the way a
   person connects their own: the popup is a proxy connector first
   (2026-10-12). Three screens at 2x; every IP address on screen is swapped
   for an example one (RFC 5737) before a capture. Then each screen is
   placed on a 1280 x 800 canvas with one line saying what it shows, the
   size the store asks for, plus the 440 x 280 promo tile.

   Writes: store-1-connected.png, store-2-checks.png, store-3-free.png,
   promo-440x280.png, and the raw popup captures (popup-*.png).
   ============================================================ */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extensionIdFromKey, launchWithExtension, navigate, newPage } from "../tests/e2e/cdp.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const ONLY = ARGS.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? null;
const OUT = resolve(ARGS.find((a) => !a.startsWith("--")) || join(EXT, "dist", "store"));
mkdirSync(OUT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const ID = extensionIdFromKey(manifest.key);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Every IPv4 on the page becomes an example address, the same one each time. */
const MASK = `(() => {
  const examples = ["203.0.113.24", "198.51.100.7", "192.0.2.61", "203.0.113.130"];
  const seen = new Map();
  const swap = (s) => s.replace(/\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g, (ip) => {
    if (!seen.has(ip)) seen.set(ip, examples[seen.size % examples.length]);
    return seen.get(ip);
  });
  /* An address caught while it turns is a wheel per digit, which no text search matches (1.0.3's
     rested as wheels, and a capture of it kept the real address): it becomes its plain text first. */
  document.querySelectorAll(".digits").forEach((n) => {
    n.textContent = n.dataset.text || n.getAttribute("aria-label") || n.textContent;
    n.classList.remove("digits");
  });
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = swap(n.nodeValue);
  document.querySelectorAll("[title]").forEach((e) => (e.title = swap(e.title)));
  // The exit's network in plain words, as on the phone's pictures: a store page names no hosting
  // company (the first 1.0.2 picture named the free exit's host, which is also ours).
  document.querySelectorAll(".arow").forEach((row) => {
    const label = row.querySelector(".arow-label")?.textContent.trim();
    const d = row.querySelector(".arow-detail");
    if (label === "Exit address" && d) {
      // Double backslashes: this is a template string, and a single one would reach the page as
      // "(.?)", which ate the last letter of a network's name ("a hosting networkC" for "… LLC").
      d.textContent = d.textContent.replace(/^(.+?) · (.+?)(\\.?)(?= Leaves by another address|$)/, "$1 · a hosting network$3");
    }
    // The resolver's network likewise: "Some Host GmbH, DE" becomes "A network in DE".
    const v = row.querySelector(".arow-value");
    if (label === "DNS resolver" && v && row.dataset.status === "ok") {
      v.textContent = v.textContent.replace(/^.+?, ([A-Z]{2})$/, "A network in $1");
    }
  });
  // This run loads the folder unpacked, and such a copy says so; the store's copy never does.
  const hand = document.getElementById("handLoaded");
  if (hand) hand.hidden = true;
  return seen.size;
})()`;

/* A US visitor's browser (English, New York time), connected to a US exit below: the checks then
   judge a setup a reader recognises, instead of this computer's own language and time zone. */
const { cdp, close } = await launchWithExtension({
  extensionDir: EXT,
  headless: true,
  extraArgs: ["--lang=en-US", "--accept-lang=en-US"],
});
const shots = {};
try {
  // The popup captures, which need a live free exit. The promo tile alone does not.
  if (ONLY !== "promo") {
  const page = await newPage(cdp, { width: 400, height: 600 });
  const s = page.sessionId;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 384, height: 600, deviceScaleFactor: 2, mobile: false }, s);
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" }, s);
  const js = (e) => cdp.evaluate(s, e);
  const capture = async (name) => {
    await js(MASK);
    await sleep(150);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, s);
    const file = join(OUT, `popup-${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    shots[name] = file;
  };
  const surface = async (name) => {
    await js(`document.querySelector('[data-surface="${name}"]')?.click()`);
    await sleep(700);
  };

  const popup = `chrome-extension://${ID}/popup.html`;
  await navigate(cdp, s, popup, 30_000);
  // A few proxies kept, as someone who has used it a while has them (example addresses).
  await js(`chrome.storage.local.set({ hproxy_last_surface: "proxies", hproxy_byo: [
    { host: "198.51.100.7", port: 8080, scheme: "http", username: "user", password: "pass", country: "NL" },
    { host: "192.0.2.44", port: 1080, scheme: "socks5", username: "", password: "", country: "DE" },
    { host: "198.51.100.23", port: 8000, scheme: "http", username: "user", password: "pass", country: "GB" },
  ] })`);
  await navigate(cdp, s, popup, 30_000);
  await sleep(2500);

  // 3. Free, not connected: the fastest free proxy on top, the countries.
  await surface("vpn");
  await capture("free");

  // A tested exit from the free pool: a US one from the list (the fastest one when the list has no US).
  await js(`(document.querySelector('#countryList .row[data-cc="US"]') || document.getElementById("quickBtn")).click()`);
  const phase = () => js(`document.getElementById("conn")?.dataset.phase`);
  let on = false;
  for (let i = 0; i < 45 && !on; i++) {
    await sleep(1000);
    on = (await phase()) === "on";
  }
  if (!on) throw new Error("no free exit connected within 45 s; run again");

  // 1. Kept as one of My proxies and connected from its row, as a person connects their own.
  const exit = (await js(`chrome.runtime.sendMessage({ type: "status" })`))?.active;
  if (!exit?.host) throw new Error("the free exit's address did not come back");
  await js(`chrome.storage.local.get("hproxy_byo").then((o) => chrome.storage.local.set({ hproxy_byo: [
    { host: ${JSON.stringify(exit.host)}, port: ${Number(exit.port)}, scheme: ${JSON.stringify(exit.scheme || "http")}, username: "", password: "", country: ${JSON.stringify(exit.country || "")} },
    ...o.hproxy_byo ] }))`);
  await surface("proxies");
  // Off the free session first: pressing the row of the proxy in use disconnects it.
  await js(`chrome.runtime.sendMessage({ type: "disconnect" })`);
  for (let i = 0; i < 20 && (await phase()) !== "off"; i++) await sleep(300);
  await sleep(600);
  await js(`document.querySelector('#byoList .row[data-key="${exit.host}:${exit.port}"]').click()`);
  const mode = () => js(`chrome.runtime.sendMessage({ type: "status" }).then((r) => r?.active?.mode || "")`);
  for (let i = 0; i < 30 && (await mode()) !== "pin"; i++) await sleep(500);
  const analysed = async () => {
    for (let i = 0; i < 40; i++) {
      if (!(await js(`document.getElementById("analyze")?.hidden`)) && (await js(`document.getElementById("analyze")?.dataset.state`)) === "done") return;
      await sleep(500);
    }
  };
  await analysed();
  // A free exit can miss one of the checks' requests; the popup's own "Check again" (up to three
  // times) until the exit row answered, so the pictures show a real result.
  for (let i = 0; i < 3; i++) {
    const exitAnswered = await js(
      `[...document.querySelectorAll(".arow")].some((r) => r.querySelector(".arow-label")?.textContent.trim() === "Exit address" && r.dataset.status === "ok")`,
    );
    if (exitAnswered) break;
    await js(`document.getElementById("reanalyze").click()`);
    await sleep(800);
    await analysed();
  }
  // The checks as one line, as they stand when all is well.
  if ((await js(`document.getElementById("checksToggle").getAttribute("aria-expanded")`)) === "true") await js(`document.getElementById("checksToggle").click()`);
  await sleep(900);
  await capture("connected");

  // 2. The checks, opened.
  await js(`document.getElementById("checksToggle").click()`);
  await sleep(900);
  await capture("checks");
  await js(`chrome.runtime.sendMessage({ type: "disconnect" })`);
  await sleep(500);
  }

  /* The canvases: one line of words on the left, the popup on the right. */
  const H = `<svg viewBox="0 0 22 26" width="30" height="36"><defs><linearGradient id="g" x1="0" y1="0" x2="22" y2="26" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3d7bff"/><stop offset=".5" stop-color="#0158ff"/><stop offset="1" stop-color="#013599"/></linearGradient></defs><g fill="url(#g)"><path d="M0 0V0C3.98547 0 7.21633 3.23086 7.21633 7.21633V26H0V0Z"/><rect x="14.2188" width="7.21633" height="26"/><path d="M7.2349 26H0V15.9714C0 12.4548 2.85076 9.60408 6.36735 9.60408H14.2204V0H21.4367V10.4531C21.4367 13.9696 18.586 16.8204 15.0694 16.8204H7.2349V26Z"/></g></svg>`;
  const scenes = [
    ["store-1-connected", "connected", "Your proxies, one click away.", "Paste a proxy once, in any format. It is tested in your browser, kept, and connected with one click."],
    ["store-2-checks", "checks", "See what your proxy really does.", "Exit address, header leaks, DNS, WebRTC, time zone and language, checked on every connect."],
    ["store-3-free", "free", "No proxy yet? Free ones, tested first.", "Pick a country or the fastest one. Your pages only move once an exit has passed."],
  ];
  // The popup's own font (Inter, since 2026-10-12; DM Sans until 1.0.3).
  const font = pathToFileURL(join(EXT, "fonts", "Inter-Variable-latin.woff2")).href;
  /* Plain white ground, the popup framed by a solid hairline and its shadow: nothing see-through
     (the house rule since 2026-09-26; until 2026-10-10 these canvases carried see-through blue glows,
     a pale blue gradient and a fading dot texture). */
  const canvas = (img, title, sub) => `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: "Inter"; src: url("${font}") format("woff2"); font-weight: 100 900; }
    * { box-sizing: border-box; } html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
    body { position: relative; font-family: "Inter", system-ui, sans-serif; color: #0a1020; background: #ffffff; }
    .words { position: absolute; left: 96px; top: 0; bottom: 0; width: 560px; display: flex; flex-direction: column; justify-content: center; }
    .brand { display: flex; align-items: center; gap: 12px; font-size: 26px; font-weight: 750; letter-spacing: -0.02em; }
    h1 { margin: 34px 0 0; font-size: 54px; line-height: 1.05; font-weight: 750; letter-spacing: -0.035em; }
    p { margin: 22px 0 0; font-size: 22px; line-height: 1.45; font-weight: 500; color: #48536d; max-width: 500px; }
    .popup { position: absolute; right: 110px; top: 45px; width: 452px; height: 706px; border-radius: 18px; overflow: hidden;
      background: #fff; transform: perspective(2400px) rotateY(-9deg) rotateX(3deg);
      box-shadow: 0 60px 120px -30px rgba(10, 20, 50, 0.45), 0 24px 48px -18px rgba(10, 20, 50, 0.30), 0 0 0 1px #e7e7e4; }
    .popup img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
  </style></head><body>
    <div class="words"><div class="brand">${H}<span>HProxy</span></div><h1>${title}</h1><p>${sub}</p></div>
    <div class="popup"><img src="${pathToFileURL(img).href}"></div>
  </body></html>`;
  /* The promo tile: the screenshots' white ground, the blue H, dark words. The logo is always the
     blue H, never a white H on a blue field (2026-09-25: the first tile was exactly that). */
  const promo = `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: "Inter"; src: url("${font}") format("woff2"); font-weight: 100 900; }
    html, body { margin: 0; width: 440px; height: 280px; overflow: hidden; }
    body { position: relative; display: flex; flex-direction: column; justify-content: center; padding: 0 36px; box-sizing: border-box;
      color: #0a1020; font-family: "Inter", system-ui, sans-serif; background: #ffffff; }
    .brand, p { position: relative; }
    .brand { display: flex; align-items: center; gap: 12px; font-size: 34px; font-weight: 750; letter-spacing: -0.03em; }
    p { margin: 14px 0 0; font-size: 19px; line-height: 1.35; font-weight: 600; color: #48536d; }
  </style></head><body><div class="brand">${H}<span>HProxy</span></div>
    <p>Your proxy in Chrome in one press, and what it really does.</p></body></html>`;

  const render = async (html, file, width, height) => {
    const htmlFile = join(OUT, `${file}.html`);
    writeFileSync(htmlFile, html);
    const p = await newPage(cdp, { width, height });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, p.sessionId);
    await navigate(cdp, p.sessionId, pathToFileURL(htmlFile).href, 30_000);
    await sleep(800);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, p.sessionId);
    writeFileSync(join(OUT, `${file}.png`), Buffer.from(shot.data, "base64"));
    console.log(join(OUT, `${file}.png`));
  };
  if (ONLY !== "promo") for (const [file, shot, title, sub] of scenes) await render(canvas(shots[shot], title, sub), file, 1280, 800);
  await render(promo, "promo-440x280", 440, 280);
} finally {
  await close();
}
