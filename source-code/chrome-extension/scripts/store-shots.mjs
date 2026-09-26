/* ============================================================
   store-shots.mjs: the Chrome Web Store pictures, from the real popup.

     node scripts/store-shots.mjs <output folder>
     node scripts/store-shots.mjs <output folder> --only=promo   (the promo tile alone)

   Opens the popup of THIS folder's extension in Chrome for Testing (never
   the installed Chrome: tests/e2e/cdp.mjs), connects through the live free
   pool, and captures three screens at 2x. Every IP address on screen is
   swapped for an example one (RFC 5737) before a capture. Then each screen
   is placed on a 1280 x 800 canvas with one line saying what it shows, the
   size the store asks for, plus the 440 x 280 promo tile.

   Writes: store-1-connected.png, store-2-free.png, store-3-checks.png,
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
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = swap(n.nodeValue);
  document.querySelectorAll("[title]").forEach((e) => (e.title = swap(e.title)));
  return seen.size;
})()`;

const { cdp, close } = await launchWithExtension({ extensionDir: EXT, headless: true });
const shots = {};
try {
  // The popup captures, which need a live free exit. The promo tile alone does not.
  if (ONLY !== "promo") {
  const page = await newPage(cdp, { width: 400, height: 600 });
  const s = page.sessionId;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 384, height: 600, deviceScaleFactor: 2, mobile: false }, s);
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

  await navigate(cdp, s, `chrome-extension://${ID}/popup.html`, 30_000);
  await sleep(2500);

  // 2. Free, not connected yet: the countries, Quick Connect on top.
  await surface("vpn");
  await capture("free");

  // 1. Connected: press the H (the fastest free exit), wait for it.
  await js(`document.getElementById("hbutton").click()`);
  let on = false;
  for (let i = 0; i < 45 && !on; i++) {
    await sleep(1000);
    on = await js(`document.getElementById("conn")?.dataset.phase === "on"`);
  }
  if (!on) throw new Error("no free exit connected within 45 s; run again");
  await sleep(2600);
  await capture("connected");

  // 3. The checks under "This connection", on My proxies.
  await surface("proxies");
  for (let i = 0; i < 40; i++) {
    if ((await js(`document.getElementById("analyze")?.dataset.state`)) === "done") break;
    await sleep(500);
  }
  await js(`document.getElementById("analyze").scrollIntoView({ block: "start" }); window.scrollBy(0, -12)`);
  await sleep(600);
  await capture("checks");
  await js(`chrome.runtime.sendMessage({ type: "disconnect" })`);
  await sleep(500);
  }

  /* The canvases: one line of words on the left, the popup on the right. */
  const H = `<svg viewBox="0 0 22 26" width="30" height="36"><defs><linearGradient id="g" x1="0" y1="0" x2="22" y2="26" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3d7bff"/><stop offset=".5" stop-color="#0158ff"/><stop offset="1" stop-color="#013599"/></linearGradient></defs><g fill="url(#g)"><path d="M0 0V0C3.98547 0 7.21633 3.23086 7.21633 7.21633V26H0V0Z"/><rect x="14.2188" width="7.21633" height="26"/><path d="M7.2349 26H0V15.9714C0 12.4548 2.85076 9.60408 6.36735 9.60408H14.2204V0H21.4367V10.4531C21.4367 13.9696 18.586 16.8204 15.0694 16.8204H7.2349V26Z"/></g></svg>`;
  const scenes = [
    ["store-1-connected", "connected", "One press on the H.", "Chrome goes through your proxy or a tested free one, and the card shows where you appear."],
    ["store-2-free", "free", "Free proxies, tested first.", "Pick a country or Quick Connect. Your pages only move once an exit has passed."],
    ["store-3-checks", "checks", "See what your proxy really does.", "Exit address, header leaks, WebRTC, time zone and language, checked on every connect."],
  ];
  const font = pathToFileURL(join(EXT, "fonts", "DMSans-Variable.woff2")).href;
  const canvas = (img, title, sub) => `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: "DM Sans"; src: url("${font}") format("woff2"); font-weight: 100 1000; }
    * { box-sizing: border-box; } html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
    body { position: relative; font-family: "DM Sans", system-ui, sans-serif; color: #0a1020;
      background: radial-gradient(760px 560px at 80% 30%, rgba(1, 88, 255, 0.14), transparent 70%),
                  radial-gradient(700px 600px at 5% 95%, rgba(61, 123, 255, 0.10), transparent 70%),
                  linear-gradient(180deg, #f7f9fe, #eef2fb); }
    body::before { content: ""; position: absolute; inset: 0;
      background-image: radial-gradient(rgba(10, 16, 32, 0.07) 1px, transparent 1.2px); background-size: 22px 22px;
      -webkit-mask-image: radial-gradient(800px 600px at 60% 45%, black, transparent 75%); }
    .words { position: absolute; left: 96px; top: 0; bottom: 0; width: 560px; display: flex; flex-direction: column; justify-content: center; }
    .brand { display: flex; align-items: center; gap: 12px; font-size: 26px; font-weight: 750; letter-spacing: -0.02em; }
    h1 { margin: 34px 0 0; font-size: 54px; line-height: 1.05; font-weight: 750; letter-spacing: -0.035em; }
    p { margin: 22px 0 0; font-size: 22px; line-height: 1.45; font-weight: 500; color: #48536d; max-width: 500px; }
    .popup { position: absolute; right: 110px; top: 45px; width: 452px; height: 706px; border-radius: 18px; overflow: hidden;
      background: #fff; transform: perspective(2400px) rotateY(-9deg) rotateX(3deg);
      box-shadow: 0 60px 120px -30px rgba(10, 20, 50, 0.45), 0 24px 48px -18px rgba(10, 20, 50, 0.30), 0 0 0 1px rgba(10, 20, 50, 0.08); }
    .popup img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
  </style></head><body>
    <div class="words"><div class="brand">${H}<span>HProxy</span></div><h1>${title}</h1><p>${sub}</p></div>
    <div class="popup"><img src="${pathToFileURL(img).href}"></div>
  </body></html>`;
  /* The promo tile: the screenshots' light ground, the blue H, dark words. The logo is always the
     blue H, never a white H on a blue field (2026-09-25: the first tile was exactly that). */
  const promo = `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: "DM Sans"; src: url("${font}") format("woff2"); font-weight: 100 1000; }
    html, body { margin: 0; width: 440px; height: 280px; overflow: hidden; }
    body { position: relative; display: flex; flex-direction: column; justify-content: center; padding: 0 36px; box-sizing: border-box;
      color: #0a1020; font-family: "DM Sans", system-ui, sans-serif;
      background: radial-gradient(300px 220px at 88% 18%, rgba(1, 88, 255, 0.14), transparent 70%),
                  radial-gradient(280px 220px at 0% 100%, rgba(61, 123, 255, 0.10), transparent 70%),
                  linear-gradient(180deg, #f7f9fe, #eef2fb); }
    body::before { content: ""; position: absolute; inset: 0;
      background-image: radial-gradient(rgba(10, 16, 32, 0.07) 1px, transparent 1.2px); background-size: 18px 18px;
      -webkit-mask-image: radial-gradient(300px 220px at 70% 40%, black, transparent 75%); }
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
