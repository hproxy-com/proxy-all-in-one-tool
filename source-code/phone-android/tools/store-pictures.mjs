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

/** The pictures, in the order Play shows them: the raw screen, the words, and the second line, in
 *  blue. The raw screens of 0.4.1 (2026-10-19): ten free proxies shared to the pictures build as
 *  example addresses, added, checked, one connected, one named with a last day. */
const PHONES = [
  { name: "1-connect", raw: "connected.png", title: "One tap connects", blue: "the whole phone", sub: "Every app goes through the proxy you pick." },
  { name: "2-add", raw: "add.png", title: "Paste your proxies", blue: "all at once", sub: "Or share them, scan a QR code or type one." },
  { name: "3-tested", raw: "my-proxies.png", title: "Every proxy tested,", blue: "fraud score included", sub: "Speed and fraud score the moment it is added." },
  { name: "4-check", raw: "checker.png", title: "Check any list,", blue: "fastest first", sub: "Every line is tested from your phone." },
  { name: "5-last-day", raw: "proxy-sheet.png", title: "A name, a last day", blue: "and a reminder", sub: "HProxy tells you 3 days before a plan ends." },
  { name: "6-free", raw: "free.png", title: "Free proxies", blue: "by country", sub: "Sorted by fraud score, speed or reliability." },
  { name: "7-help", raw: "help.png", title: "Talk to us", blue: "right in the app", sub: "A live chat with HProxy support." },
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

// The part of a raw screen that shows: below the status bar, above the gesture bar. The raw screens
// come from the Android 15 emulator HProxy_Android15 (a Pixel 7 with its camera cutout): a status
// bar of 136 px, a gesture bar of 63.
const RAW_W = 1080;
const CUT_TOP = 136;
const CUT_BOTTOM = 64;
const SHOWN_H = 2400 - CUT_TOP - CUT_BOTTOM;

// Inter, the app's own font since 2026-10-11 (app/src/main/res/font).
const fontFace = `
@font-face { font-family: Inter; src: url(/font/inter_extrabold.ttf); font-weight: 800; }
@font-face { font-family: Inter; src: url(/font/inter_bold.ttf); font-weight: 700; }
@font-face { font-family: Inter; src: url(/font/inter_semibold.ttf); font-weight: 600; }
@font-face { font-family: Inter; src: url(/font/inter_medium.ttf); font-weight: 500; }`;

/** The phone's measures at a 1330 px screen (the store pictures), scaled with the screen. */
function measures(screenH) {
  const k = screenH / 1330;
  return {
    screenW: Math.round(RAW_W * (screenH / SHOWN_H)),
    side: Math.round(16 * k),
    head: Math.round(40 * k),
    edge: Math.max(1, Math.round(2 * k)),
    outer: Math.round(68 * k),
    inner: Math.round(50 * k),
    lens: Math.max(4, Math.round(14 * k)),
    lensTop: Math.round(13 * k),
  };
}

/** The whole phone's box, its edge included. */
function phoneBox(screenH) {
  const m = measures(screenH);
  return { w: m.screenW + m.side * 2 + m.edge * 2, h: screenH + m.head + m.side + m.edge * 2 };
}

/** A phone around one raw screen, `screenH` tall, at (left, top). */
function phone(raw, left, top, screenH) {
  const scale = screenH / SHOWN_H;
  const m = measures(screenH);
  return `<div style="position:absolute;left:${left}px;top:${top}px;width:${m.screenW + m.side * 2}px;height:${screenH + m.head + m.side}px;background:${BEZEL};border:${m.edge}px solid ${EDGE};border-radius:${m.outer}px;box-sizing:content-box">
    <div style="position:absolute;left:50%;top:${m.lensTop}px;width:${m.lens}px;height:${m.lens}px;margin-left:${-m.lens / 2}px;border-radius:50%;background:${CANVAS}"></div>
    <div style="position:absolute;left:${m.side}px;top:${m.head}px;width:${m.screenW}px;height:${screenH}px;border-radius:${m.inner}px;overflow:hidden;background:#070a12">
      <img src="/raw/${raw}" style="position:absolute;left:0;top:${-Math.round(CUT_TOP * scale)}px;width:${m.screenW}px;height:${Math.round(2400 * scale)}px">
    </div>
  </div>`;
}

function phonePage(p) {
  const screenH = 1330;
  const scale = screenH / SHOWN_H;
  const deviceW = Math.round(RAW_W * scale) + 32 + 4;
  return `<!doctype html><meta charset=utf-8><style>${fontFace}
  html, body { margin: 0; width: 1080px; height: 1920px; background: ${CANVAS}; overflow: hidden; }
  h1 { margin: 0; font: 700 80px/1.08 Inter; letter-spacing: -0.03em; color: ${INK}; white-space: nowrap; }
  h1 b { color: ${BLUE}; font-weight: 700; }
  p { margin: 26px 0 0; font: 500 38px/1.3 Inter; color: ${MUTE}; white-space: nowrap; }
  </style><body>
  <div style="position:absolute;left:96px;top:118px;width:900px"><h1>${p.title}<br><b>${p.blue}</b></h1><p>${p.sub}</p></div>
  ${phone(p.raw, Math.round((1080 - deviceW) / 2), 470, screenH)}
  </body>`;
}

function featurePage() {
  // Three whole phones, every edge inside the banner (2026-10-19: the one that ran off the bottom
  // looked cut off): a list pasted in, connected in the middle, the proxies with their fraud
  // scores. The middle one stands taller; all three share one centre line.
  const sideH = 312;
  const mainH = 366;
  const side = phoneBox(sideH);
  const main = phoneBox(mainH);
  const gap = 18;
  const right = 1024 - 44;
  const x3 = right - side.w;
  const x2 = x3 - gap - main.w;
  const x1 = x2 - gap - side.w;
  const yMain = Math.round((500 - main.h) / 2);
  const ySide = Math.round((500 - side.h) / 2);
  return `<!doctype html><meta charset=utf-8><style>${fontFace}
  html, body { margin: 0; width: 1024px; height: 500px; background: ${CANVAS}; overflow: hidden; }
  </style><body>
  <div style="position:absolute;left:46px;top:150px;width:58px;height:70px">${H_MARK.replace("<svg ", '<svg width="58" height="70" ')}</div>
  <div style="position:absolute;left:120px;top:146px;font:800 66px/1 Inter;letter-spacing:-0.035em;color:${INK}">HProxy</div>
  <div style="position:absolute;left:48px;top:246px;font:600 25px/1.25 Inter;letter-spacing:-0.01em;color:${INK}">Proxy check and connect</div>
  <div style="position:absolute;left:48px;top:284px;width:${x1 - 48 - 24}px;font:500 19px/1.4 Inter;color:${MUTE}">Paste a list, see every proxy's speed and fraud score, connect in one tap.</div>
  <div style="position:absolute;left:48px;top:350px;font:700 19px/1.2 Inter;color:${BLUE}">Free, no ads, no account</div>
  ${phone("add.png", x1, ySide, sideH)}
  ${phone("connected.png", x2, yMain, mainH)}
  ${phone("my-proxies.png", x3, ySide, sideH)}
  </body>`;
}

// ------------------------------------------------------------------------------------------
// Drawing
// ------------------------------------------------------------------------------------------

for (const p of PHONES) if (!existsSync(join(RAW, p.raw))) throw new Error(`missing ${join(RAW, p.raw)}`);
for (const f of ["inter_extrabold.ttf", "inter_bold.ttf", "inter_semibold.ttf", "inter_medium.ttf"]) {
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
