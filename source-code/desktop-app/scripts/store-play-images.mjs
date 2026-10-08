// store-play-images.mjs: every picture of the Google Play listing, drawn from the app's own screens.
// Run from desktop-app/ with the preview server up (npx vite --port 1420):
//
//   node scripts/store-play-images.mjs            store/google-play/listing/
//
// What it makes (Play's sizes, 2026-09-28):
//   phone-<n>-<name>.png      1080 x 1920   phone screenshots (Play asks for 2 to 8; 4 or more at
//                                           1080 px make the app eligible for Play's own promotion).
//                                           A 7-inch tablet draws the same phone layout (under 720 px
//                                           wide), so the same files go into the 7-inch slot.
//   tablet-<n>-<name>.png     1920 x 1080   10-inch tablet screenshots, the wide layout.
//   feature-graphic.png       1024 x 500    the banner at the top of the listing.
//
// The house rules every picture keeps:
//   - The dark look behind everything (his pick): the app ink canvas, solid, no tint, no glass, no
//     shadow, nothing see-through; the device has a solid hairline edge.
//   - The brand mark is the blue H, never a white H and never a blue field behind it.
//   - Every address is from the ranges set aside for examples (RFC 5737), every network number
//     from the numbers set aside for examples (RFC 5398, AS64496 to AS64511), and every network
//     is a plain description instead of another company's name.
//   - The words say what the app does, in plain words, no claim the app cannot back.
// It fails on any page error, on anything wider than the screen, and on a company name left over.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchWithExtension, newPage, navigate } from "../../chrome-extension/tests/e2e/cdp.mjs";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(APP, "store", "google-play", "listing");
const URL = "http://localhost:1420/";
const PHONE_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const TABLET_UA = "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const EXAMPLE_LIST = [
  "203.0.113.20:8080",
  "198.51.100.44:3128:user:pass",
  "192.0.2.8:1080",
  "203.0.113.5:8888",
  "198.51.100.9:80",
  "192.0.2.117:443",
  "203.0.113.15:30588",
  "198.51.100.133:8811",
  "192.0.2.83:3128",
  "203.0.113.17:1080",
].join("\n");

/* The preview's pretend networks carry real companies' names and numbers (src/lib/preview.ts,
   previewConnect.ts). On a store page they become plain descriptions with example numbers. */
const NETWORKS = [
  ["DigitalOcean", "Cloud Hosting", "AS14061", "AS64500"],
  ["Amazon AWS", "Data Center", "AS16509", "AS64501"],
  ["Hetzner Online", "Server Hosting", "AS24940", "AS64502"],
  ["Akamai Linode", "Edge Hosting", "AS63949", "AS64503"],
  ["Comcast Cable", "Home Broadband", "AS7922", "AS64504"],
  ["Deutsche Telekom", "Home Fiber", "AS3320", "AS64505"],
  ["China Telecom", "Metro Telecom", "AS4134", "AS64506"],
  ["VNPT", "City Broadband", "AS45899", "AS64507"],
];

/* The dark look, his pick for every store picture (2026-09-28: "only pictures of the dark mode,
   it looks the best"). The colours are the app's own dark tokens (src/styles/globals.css,
   [data-theme="midnight"]): the ink canvas is one of the three solid fills the house allows. */
const CANVAS = "#0b1120"; // --canvas
const BEZEL = "#1a2542"; // --raised
const EDGE = "#26324f"; // --bar, a solid hairline around the device
const INK = "#eef2fb"; // --ink
const MUTE = "#aab4cf"; // --ink-mute
const BLUE = "#3d7bff"; // --digi
/* The H in the app's dark-mode gradient (components/HLetter.tsx: --digi-light, --digi,
   --digi-deep): the brand gradient's own dark end would vanish on the ink canvas. Blue H, no
   white H, no blue field behind it. */
const H_MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21.4367 26"><defs><linearGradient id="h" x1="0" y1="0" x2="22" y2="26" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8db1ff"/><stop offset="0.5" stop-color="#3d7bff"/><stop offset="1" stop-color="#2d63e6"/></linearGradient></defs><g fill="url(#h)"><path d="M0 0V0C3.98547 0 7.21633 3.23086 7.21633 7.21633V26H0V0Z"/><rect x="14.2188" width="7.21633" height="26"/><path d="M7.2349 26H0V15.9714C0 12.4548 2.85076 9.60408 6.36735 9.60408H14.2204V0H21.4367V10.4531C21.4367 13.9696 18.586 16.8204 15.0694 16.8204H7.2349V26Z"/></g></svg>`;
/* What the app keeps in localStorage for a first start in the dark look (src/lib/settings.ts:
   the theme counts only next to the current look marker). */
const DARK_SETTINGS = JSON.stringify({ theme: "midnight", look: "d-2026-09-23" });

const fontDir = join(APP, "node_modules", "@fontsource-variable", "dm-sans", "files");
const fontFile = ["dm-sans-latin-wght-normal.woff2", "dm-sans-latin-standard-normal.woff2"].map((f) => join(fontDir, f)).find(existsSync);
if (!fontFile) throw new Error(`no DM Sans in ${fontDir}: npm install first`);
const FONT = readFileSync(fontFile).toString("base64");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const png64 = (buf) => `data:image/png;base64,${buf.toString("base64")}`;
const problems = [];

mkdirSync(OUT, { recursive: true });
const { cdp, close } = await launchWithExtension({ extensionDir: null, headless: true });
try {
  /* ── 1. The app's own screens ─────────────────────────────────────────────── */

  const openApp = async ({ width, height, scale, ua, mobile }) => {
    const page = await newPage(cdp, { width, height });
    const s = page.sessionId;
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile }, s);
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: ua, platform: "Android" }, s);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, s);
    cdp.on((m) => {
      if (m.sessionId === s && m.method === "Runtime.exceptionThrown") {
        problems.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
      }
    });
    const js = (e) => cdp.evaluate(s, e);
    const clickText = async (text) => {
      const hit = await js(`(() => {
        const b = [...document.querySelectorAll('button,[role=tab],a')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!hit) throw new Error(`nothing to click that says "${text}"`);
    };
    const shoot = async (name) => {
      // The example networks, swapped in right before the picture is taken.
      const left = await js(`(() => {
        const swaps = ${JSON.stringify(NETWORKS.flatMap(([a, b, c, d]) => [[a, b], [c, d]]))};
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          let t = n.nodeValue;
          for (const [from, to] of swaps) t = t.split(from).join(to);
          if (t !== n.nodeValue) n.nodeValue = t;
        }
        const text = document.body.innerText;
        return ${JSON.stringify(NETWORKS.map(([a]) => a))}.filter((name) => text.includes(name));
      })()`);
      if (left.length) problems.push(`${name}: still names ${left.join(", ")}`);
      const wider = await js(`document.documentElement.scrollWidth > innerWidth`);
      if (wider) problems.push(`${name}: something is wider than the screen`);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, s);
      return Buffer.from(data, "base64");
    };
    return { s, js, clickText, shoot };
  };

  // A first start in the dark look: nothing saved but the theme, then the page asked for.
  const start = async (app, url) => {
    await navigate(cdp, app.s, URL, 60_000);
    await app.js(`localStorage.clear(); localStorage.setItem("hproxy-checker-settings", ${JSON.stringify(DARK_SETTINGS)})`);
    await navigate(cdp, app.s, url, 60_000);
    const dark = await app.js(`document.documentElement.getAttribute("data-theme")`);
    if (dark !== "midnight") throw new Error(`${url} did not open in the dark look`);
  };

  const checkRun = async (app) => {
    await start(app, URL);
    await sleep(1500);
    await app.clickText("Check");
    await sleep(800);
    await app.js(`document.querySelector('textarea[aria-label="Proxy list"]').focus()`);
    await cdp.send("Input.insertText", { text: EXAMPLE_LIST }, app.s);
    await sleep(400);
    await app.clickText("Check 10");
    await sleep(9000);
    await app.clickText("Fraud scores");
    await sleep(2500);
  };

  const raw = {};

  // Phone: 360 x 800 CSS pixels at 3x. The frame shows the top of it.
  const phone = await openApp({ width: 360, height: 800, scale: 3, ua: PHONE_UA, mobile: true });
  await start(phone, `${URL}?demo=connect`);
  await sleep(3500);
  raw.connect = await phone.shoot("phone connect");
  await checkRun(phone);
  raw.check = await phone.shoot("phone check");
  await phone.js(`document.querySelector('.ux-row')?.click()`);
  await sleep(600);
  // The sheet's own top (the address and its verdict) at the top of the screen: the frame
  // shows the upper part of the phone.
  await phone.js(`document.querySelector('.ux-sheet')?.scrollIntoView({ block: 'start' })`);
  await sleep(900);
  raw.details = await phone.shoot("phone details");
  // The Map look of the connected card (Settings, "When connected"): where you appear, lit up.
  await start(phone, `${URL}?demo=connect&look=map`);
  await sleep(3500);
  raw.map = await phone.shoot("phone map");

  // 10-inch tablet: 1280 x 800 CSS pixels at 1.5x, the wide layout.
  const tablet = await openApp({ width: 1280, height: 800, scale: 1.5, ua: TABLET_UA, mobile: true });
  await start(tablet, `${URL}?demo=connect`);
  await sleep(3500);
  raw.tabletConnect = await tablet.shoot("tablet connect");
  await checkRun(tablet);
  raw.tabletCheck = await tablet.shoot("tablet check");

  for (const [k, v] of Object.entries(raw)) writeFileSync(join(OUT, `raw-${k}.png`), v);

  /* ── 2. The pictures ──────────────────────────────────────────────────────── */

  const base = `
    @font-face { font-family: "DM Sans"; src: url(data:font/woff2;base64,${FONT}) format("woff2"); font-weight: 100 1000; }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: ${CANVAS}; overflow: hidden; }
    body { font-family: "DM Sans", sans-serif; color: ${INK}; position: relative; -webkit-font-smoothing: antialiased; }
    h1 { margin: 0; font-weight: 700; text-wrap: balance; }
    h1 b { color: ${BLUE}; font-weight: 700; }
    p { margin: 0; font-weight: 500; color: ${MUTE}; text-wrap: balance; }
    .device { position: absolute; background: ${BEZEL}; box-shadow: 0 0 0 2px ${EDGE}; }
    .screen { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${CANVAS}; }
    .screen img { display: block; width: 100%; }
  `;

  const page = await newPage(cdp, { width: 1080, height: 1920 });
  const draw = async (name, width, height, html) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, page.sessionId);
    const { frameTree } = await cdp.send("Page.getFrameTree", {}, page.sessionId);
    await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html }, page.sessionId);
    await cdp.evaluate(page.sessionId, `Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]).then(() => true)`);
    await sleep(300);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } }, page.sessionId);
    writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
    console.log(`saved ${name} (${width} x ${height})`);
  };

  // Phone pictures: the words on top, the phone rising from the bottom edge.
  const phonePicture = (title, line, shot) => `<!doctype html><html><head><meta charset="utf-8"><style>${base}
    html, body { width: 1080px; height: 1920px; }
    body { display: flex; flex-direction: column; align-items: center; }
    .words { width: 888px; padding-top: 140px; }
    h1 { font-size: 96px; line-height: 1.02; letter-spacing: -3px; }
    p { margin-top: 34px; font-size: 42px; line-height: 1.28; letter-spacing: -0.4px; }
    .device { position: relative; flex: none; margin-top: 84px; width: 820px; height: 1760px; border-radius: 112px; padding: 22px; }
    .screen { border-radius: 90px; padding-top: 70px; }
    .screen::before { content: ""; position: absolute; top: 22px; left: 50%; width: 30px; height: 30px; margin-left: -15px; border-radius: 50%; background: ${BEZEL}; }
  </style></head><body>
    <div class="words"><h1>${title}</h1><p>${line}</p></div>
    <div class="device"><div class="screen"><img src="${png64(shot)}"></div></div>
  </body></html>`;

  // Tablet pictures: the words on the left, the tablet running off the right and bottom edges.
  const tabletPicture = (title, line, shot) => `<!doctype html><html><head><meta charset="utf-8"><style>${base}
    html, body { width: 1920px; height: 1080px; }
    .words { position: absolute; left: 110px; top: 330px; width: 560px; }
    h1 { font-size: 84px; line-height: 1.04; letter-spacing: -2.6px; }
    p { margin-top: 30px; font-size: 36px; line-height: 1.3; letter-spacing: -0.3px; }
    .device { left: 760px; top: 130px; width: 1540px; height: 1000px; border-radius: 64px; padding: 24px; }
    .screen { border-radius: 42px; }
  </style></head><body>
    <div class="words"><h1>${title}</h1><p>${line}</p></div>
    <div class="device"><div class="screen"><img src="${png64(shot)}"></div></div>
  </body></html>`;

  // The feature graphic: the blue H and the name on white, the Connect screen beside them.
  const featureGraphic = (shot) => `<!doctype html><html><head><meta charset="utf-8"><style>${base}
    html, body { width: 1024px; height: 500px; }
    .mark { position: absolute; left: 76px; top: 150px; width: 165px; height: 200px; }
    .mark svg { width: 100%; height: 100%; display: block; }
    .name { position: absolute; left: 290px; top: 140px; width: 440px; }
    h1 { font-size: 92px; line-height: 1; letter-spacing: -3px; }
    p { margin-top: 18px; font-size: 32px; line-height: 1.25; letter-spacing: -0.3px; }
    .free { margin-top: 22px; font-size: 24px; font-weight: 700; color: ${BLUE}; letter-spacing: 0; }
    .device { left: 752px; top: 64px; width: 236px; height: 520px; border-radius: 36px; padding: 8px; }
    .screen { border-radius: 29px; padding-top: 22px; }
    .screen::before { content: ""; position: absolute; top: 7px; left: 50%; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%; background: ${BEZEL}; }
  </style></head><body>
    <div class="mark">${H_MARK}</div>
    <div class="name"><h1>HProxy</h1><p>Proxy check and connect</p><p class="free">Free, no account, no ads</p></div>
    <div class="device"><div class="screen"><img src="${png64(shot)}"></div></div>
  </body></html>`;

  await draw("phone-1-connect.png", 1080, 1920, phonePicture("Connect in <b>one tap</b>", "Your own proxy, a list that takes turns, or a free exit.", raw.connect));
  await draw("phone-2-check.png", 1080, 1920, phonePicture("Check any <b>proxy list</b>", "Paste it as your provider prints it. Every line is tested from your phone.", raw.check));
  await draw("phone-3-details.png", 1080, 1920, phonePicture("Every proxy, <b>in detail</b>", "Where it comes out, how long each step takes, and why a dead one failed.", raw.details));
  await draw("phone-4-map.png", 1080, 1920, phonePicture("See where <b>you appear</b>", "The country you come out in lights up on a map of dots.", raw.map));
  await draw("tablet-1-connect.png", 1920, 1080, tabletPicture("Connect in <b>one tap</b>", "Your own proxy, a list that takes turns, or a free exit.", raw.tabletConnect));
  await draw("tablet-2-check.png", 1920, 1080, tabletPicture("Check any <b>proxy list</b>", "Protocols, anonymity, exit, speed and fraud score, for every line.", raw.tabletCheck));
  await draw("feature-graphic.png", 1024, 500, featureGraphic(raw.connect));
} finally {
  await close();
}
if (problems.length) {
  console.error(`PROBLEMS:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log(`no page errors, nothing wider than the screen, no company names: ${OUT}`);
}
