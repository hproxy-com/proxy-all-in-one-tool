// store-screenshots.mjs: the Google Play phone screenshots, from the app's own screens.
// Run from desktop-app/ with the preview server up (npx vite --port 1420):
//   node scripts/store-screenshots.mjs
//
// The app draws its phone layout when its browser says Android (src/lib/tauri.ts isMobile), so
// the page is opened as an Android phone at 360 x 640 CSS pixels, 3x: 1080 x 1920, the size Play
// recommends. Every address on them comes from the ranges set aside for examples (RFC 5737:
// 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24): a store page never shows a real server as an
// open proxy. Results, scores and places are the preview's pretend ones (src/lib/preview.ts,
// previewConnect.ts, lib/fraud.ts), worded exactly as the app words them. The script fails on
// any page error or on anything wider than the screen. Output: store/google-play/screenshots/.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchWithExtension, newPage, navigate } from "../../chrome-extension/tests/e2e/cdp.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "store", "google-play", "screenshots");
const URL = "http://localhost:1420/";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const { cdp, close } = await launchWithExtension({ extensionDir: null, headless: true });
const problems = [];
try {
  const page = await newPage(cdp, { width: 360, height: 640 });
  const s = page.sessionId;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 3, mobile: true }, s);
  await cdp.send("Emulation.setUserAgentOverride", { userAgent: ANDROID_UA, platform: "Android" }, s);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, s);
  cdp.on((m) => {
    if (m.sessionId === s && m.method === "Runtime.exceptionThrown") problems.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
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
    const wider = await js(`document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('body *')].some((el) => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el.parentElement).overflowX === 'visible' && el.parentElement.getBoundingClientRect().right <= innerWidth + 1)`);
    if (wider) problems.push(`${name}: something is wider than the screen`);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, s);
    writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
    console.log(`saved ${name}`);
  };

  // A first start: nothing saved.
  await navigate(cdp, s, URL, 60_000);
  await js(`localStorage.clear()`);
  await navigate(cdp, s, URL, 60_000);
  await sleep(1500);

  // 1. Check: the example list pasted and checked, with fraud scores.
  await clickText("Check");
  await sleep(800);
  await js(`document.querySelector('textarea[aria-label="Proxy list"]').focus()`);
  await cdp.send("Input.insertText", { text: EXAMPLE_LIST }, s);
  await sleep(400);
  await clickText("Check 10");
  await sleep(9000);
  await clickText("Fraud scores");
  await sleep(2500);
  await shoot("1-check.png");

  // 2. One proxy's details: the first working row, tapped, and the list scrolled
  // to its end so the sheet pinned under it shows whole.
  await js(`document.querySelector('.ux-row')?.click()`);
  await sleep(600);
  await js(`(() => {
    let el = document.querySelector('.ux-sheet');
    while (el && !(el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'visible')) el = el.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  })()`);
  await sleep(900);
  await shoot("2-details.png");

  // 3. Connect, connected through a list of three.
  await navigate(cdp, s, `${URL}?demo=connect`, 60_000);
  await sleep(3500);
  await shoot("3-connect.png");

  // 4. The same, in the dark look: the moon in the title bar. (Not Settings: its
  // fraud score block names other companies' services, which a store image
  // should not carry.)
  const dark = await js(`(() => {
    const b = document.querySelector('button[title="Dark mode"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!dark) throw new Error("no dark mode switch in the title bar");
  await sleep(1200);
  await shoot("4-connect-dark.png");
} finally {
  await close();
}
if (problems.length) {
  console.error(`PROBLEMS:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log("no page errors, nothing wider than the screen");
}
