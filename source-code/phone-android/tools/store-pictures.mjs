// The Google Play pictures of the Android app, drawn around the app's own screens.
//
//   node phone-android/tools/store-pictures.mjs [chrome.exe]
//
// Reads the raw screens (1080 x 2400, from the "pictures" build on an emulator: every address on
// them is one set aside for examples, app/src/main/java/com/hproxy/app/engine/Pictures.kt) from
// phone-android/store/google-play/raw/, which git ignores, and writes beside it:
//   phone-<n>-<name>.png   1080 x 1920  phone screenshots (Play takes 2 to 8; 4 or more at 1080 px
//                                       make the app eligible for Play's own promotion)
//   feature-graphic.png    1024 x 500   the banner at the top of the listing
//
// The house rules every picture keeps (as desktop-app/scripts/store-play-images.mjs did for the
// earlier app): one solid dark canvas, nothing see-through, no shadow; the phone has a solid
// hairline edge; the brand mark is the blue H on nothing, never a white H, never a blue field
// behind it; the words say what the app does, in plain words. The status bar is cut off the raw
// screens, so no clock or system icon of the emulator shows.
//
// Drawn in a separate headless Chrome for Testing with a throwaway profile (never the everyday
// browser), over the DevTools protocol with Node's own WebSocket, as tools/gen-flags.mjs does.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.argv[2] || process.env.CHROME;
if (!CHROME) {
  console.error("Chrome for Testing is needed: pass its chrome.exe, or set CHROME");
  process.exit(2);
}
const STORE = join(here, "..", "store", "google-play");
const RAW = join(STORE, "raw");
const FONTS = join(here, "..", "app", "src", "main", "res", "font");

/** The pictures, in the order Play shows them: the raw screen, the words, and the second line, in blue. */
const PHONES = [
  { name: "1-connect", raw: "connected.png", title: "One tap connects", blue: "the whole phone", sub: "Every app goes through the proxy you pick." },
  { name: "2-places", raw: "connect-to.png", title: "Free proxies", blue: "by country", sub: "Next to your own proxies and groups." },
  { name: "3-check", raw: "checker.png", title: "Check a list,", blue: "fastest first", sub: "Every line is tested from your phone." },
  { name: "4-proxy", raw: "proxy-card.png", title: "See where", blue: "it comes out", sub: "Country, city, network and speed." },
  { name: "5-sites", raw: "sites-see.png", title: "See what", blue: "sites see", sub: "Your IP, DNS, WebRTC and time zone." },
  { name: "6-apps", raw: "which-apps.png", title: "Choose", blue: "which apps", sub: "Or block apps on Wi-Fi or mobile data." },
];

// The colours of the earlier store pictures: the ink canvas, the raised device, its hairline.
const CANVAS = "#0b1120";
const BEZEL = "#1a2542";
const EDGE = "#26324f";
const INK = "#eef2fb";
const MUTE = "#aab4cf";
const BLUE = "#3d7bff";
/* The blue H, its own gradient (the app icon's), on nothing. */
const H_MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21.4367 26"><defs><linearGradient id="h" x1="0" y1="0" x2="22" y2="26" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8db1ff"/><stop offset="0.5" stop-color="#3d7bff"/><stop offset="1" stop-color="#2d63e6"/></linearGradient></defs><g fill="url(#h)"><path d="M0 0V0C3.98547 0 7.21633 3.23086 7.21633 7.21633V26H0V0Z"/><rect x="14.2188" width="7.21633" height="26"/><path d="M7.2349 26H0V15.9714C0 12.4548 2.85076 9.60408 6.36735 9.60408H14.2204V0H21.4367V10.4531C21.4367 13.9696 18.586 16.8204 15.0694 16.8204H7.2349V26Z"/></g></svg>`;

// The part of a raw screen that shows: below the status bar, above the gesture bar.
const RAW_W = 1080;
const CUT_TOP = 96;
const CUT_BOTTOM = 64;
const SHOWN_H = 2400 - CUT_TOP - CUT_BOTTOM;

const fontFace = `
@font-face { font-family: DM; src: url(/font/dm_sans_bold.ttf); font-weight: 700; }
@font-face { font-family: DM; src: url(/font/dm_sans_semibold.ttf); font-weight: 600; }
@font-face { font-family: DM; src: url(/font/dm_sans_medium.ttf); font-weight: 500; }`;

/** A phone around one raw screen, `screenH` tall, at (left, top). */
function phone(raw, left, top, screenH) {
  const scale = screenH / SHOWN_H;
  const screenW = Math.round(RAW_W * scale);
  const side = 16;
  const head = 40;
  return `<div style="position:absolute;left:${left}px;top:${top}px;width:${screenW + side * 2}px;height:${screenH + head + side}px;background:${BEZEL};border:2px solid ${EDGE};border-radius:68px;box-sizing:content-box">
    <div style="position:absolute;left:50%;top:13px;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:${CANVAS}"></div>
    <div style="position:absolute;left:${side}px;top:${head}px;width:${screenW}px;height:${screenH}px;border-radius:50px;overflow:hidden;background:#070a12">
      <img src="/raw/${raw}" style="position:absolute;left:0;top:${-Math.round(CUT_TOP * scale)}px;width:${screenW}px;height:${Math.round(2400 * scale)}px">
    </div>
  </div>`;
}

function phonePage(p) {
  const screenH = 1330;
  const scale = screenH / SHOWN_H;
  const deviceW = Math.round(RAW_W * scale) + 32 + 4;
  return `<!doctype html><meta charset=utf-8><style>${fontFace}
  html, body { margin: 0; width: 1080px; height: 1920px; background: ${CANVAS}; overflow: hidden; }
  h1 { margin: 0; font: 700 84px/1.06 DM; letter-spacing: -0.025em; color: ${INK}; }
  h1 b { color: ${BLUE}; font-weight: 700; }
  p { margin: 26px 0 0; font: 500 40px/1.3 DM; color: ${MUTE}; }
  </style><body>
  <div style="position:absolute;left:96px;top:118px;width:900px"><h1>${p.title}<br><b>${p.blue}</b></h1><p>${p.sub}</p></div>
  ${phone(p.raw, Math.round((1080 - deviceW) / 2), 470, screenH)}
  </body>`;
}

function featurePage() {
  // The phone runs off the bottom edge: the top of the connected screen, the map and the address.
  return `<!doctype html><meta charset=utf-8><style>${fontFace}
  html, body { margin: 0; width: 1024px; height: 500px; background: ${CANVAS}; overflow: hidden; }
  </style><body>
  <div style="position:absolute;left:64px;top:166px;width:124px;height:150px">${H_MARK.replace("<svg ", '<svg width="124" height="150" ')}</div>
  <div style="position:absolute;left:230px;top:150px;font:700 100px/1 DM;letter-spacing:-0.03em;color:${INK}">HProxy</div>
  <div style="position:absolute;left:232px;top:270px;font:500 32px/1.2 DM;color:${MUTE}">Proxy check and connect</div>
  <div style="position:absolute;left:232px;top:318px;font:600 28px/1.2 DM;color:${BLUE}">Free, no account, no ads</div>
  ${phone("connected.png", 714, 58, 540)}
  </body>`;
}

// ------------------------------------------------------------------------------------------
// Drawing
// ------------------------------------------------------------------------------------------

for (const p of PHONES) if (!existsSync(join(RAW, p.raw))) throw new Error(`missing ${join(RAW, p.raw)}`);
for (const f of ["dm_sans_bold.ttf", "dm_sans_semibold.ttf", "dm_sans_medium.ttf"]) {
  if (!existsSync(join(FONTS, f))) throw new Error(`missing font ${f}`);
}

const pages = new Map(PHONES.map((p) => [`/${p.name}.html`, phonePage(p)]));
pages.set("/feature.html", featurePage());
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pages.has(path)) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(pages.get(path));
    return;
  }
  const [, dir, file] = path.match(/^\/(raw|font)\/([\w.-]+)$/) || [];
  if (!dir) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const body = readFileSync(join(dir === "raw" ? RAW : FONTS, file));
    res.writeHead(200, { "content-type": dir === "raw" ? "image/png" : "font/ttf" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const served = `http://127.0.0.1:${server.address().port}`;

const profile = join(process.env.TEMP || "C:/Windows/Temp", `cft-store-${process.pid}`);
const port = 9600 + (process.pid % 300);
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--hide-scrollbars",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(path) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(150);
  }
  throw new Error("Chrome did not answer");
}

try {
  const tabs = await json("/json/list");
  const page = tabs.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === "Runtime.exceptionThrown") {
      errors.push(m.params.exceptionDetails.text);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");

  async function draw(path, w, h, file) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: served + path });
    // Every image and font loaded, then one more frame.
    for (let i = 0; i < 60; i++) {
      const r = await send("Runtime.evaluate", {
        expression: "document.readyState === 'complete' && document.fonts.status === 'loaded' && [...document.images].every(i => i.complete && i.naturalWidth > 0)",
        returnByValue: true,
      });
      if (r.result?.result?.value) break;
      await sleep(100);
    }
    await sleep(250);
    const wide = await send("Runtime.evaluate", { expression: "document.documentElement.scrollWidth", returnByValue: true });
    if (wide.result.result.value > w) throw new Error(`${path} is wider than the picture`);
    const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    writeFileSync(join(STORE, file), Buffer.from(shot.result.data, "base64"));
    console.log(`${file}  ${w} x ${h}`);
  }

  for (const p of PHONES) await draw(`/${p.name}.html`, 1080, 1920, `phone-${p.name}.png`);
  await draw("/feature.html", 1024, 500, "feature-graphic.png");
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  ws.close();
} finally {
  chrome.kill();
  server.close();
  await sleep(400);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
