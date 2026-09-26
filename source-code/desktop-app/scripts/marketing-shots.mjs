// marketing-shots.mjs: pictures of the app for the website and the stores, from the app's own
// screens. Run from desktop-app/ with the preview server up (npx vite --port 1420):
//   node scripts/marketing-shots.mjs
//
// 1. The raw screens: the real window at 1440 x 900, drawn at 2x (2880 x 1800), and the phone
//    layout at 360 x 640, drawn at 3x, each light and dark, on the White background (the default,
//    Aura, is a warm paper tone that reads as yellowish in a picture). Every address on them comes
//    from the ranges set aside for examples (RFC 5737), so no real server appears as an open
//    proxy. Settings is left out: its fraud score block names other companies' services.
// 2. The angled pictures: those screens set in perspective with soft shadows, laid out by
//    marketing-compose.html in this folder (how the 3D is made is written there), drawn at 2x.
// Output: store/marketing/raw/ and store/marketing/*.png, plus a .webp of each for the web.
// The script fails on any page error.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchWithExtension, newPage, navigate } from "../../chrome-extension/tests/e2e/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "store", "marketing");
const RAW = join(OUT, "raw");
const URL = "http://localhost:1420/";
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
  "198.51.100.61:8080",
  "192.0.2.201:3128",
  "203.0.113.88:9050",
  "198.51.100.19:1080",
].join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(RAW, { recursive: true });
const { cdp, close } = await launchWithExtension({ extensionDir: null, headless: true });
const problems = [];
try {
  const page = await newPage(cdp, { width: 1440, height: 900 });
  const s = page.sessionId;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }, s);
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
  const shoot = async (name, format = "png") => {
    // The preview says under Connect that its relay is pretend; the real app has no such line,
    // so a picture of the app leaves it out.
    const hidden = await js(`(() => {
      let n = 0;
      for (const p of document.querySelectorAll('p')) {
        if (p.textContent.trim().startsWith('Browser preview:')) { p.style.display = 'none'; n++; }
      }
      return n;
    })()`);
    if (hidden) await sleep(300);
    const { data } = await cdp.send("Page.captureScreenshot", { format }, s);
    writeFileSync(join(RAW, name), Buffer.from(data, "base64"));
    console.log(`raw ${name}`);
  };
  const setDark = async (on) => {
    const title = on ? "Dark mode" : "White mode";
    const hit = await js(`(() => {
      const b = document.querySelector('button[title="${title}"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!hit) throw new Error(`no "${title}" switch in the title bar`);
    await sleep(1000);
  };
  const runCheck = async () => {
    await clickText("Check");
    await sleep(800);
    await clickText("Type them in");
    await sleep(600);
    await js(`document.querySelector('textarea[aria-label="Proxy list"]').focus()`);
    await cdp.send("Input.insertText", { text: EXAMPLE_LIST }, s);
    await sleep(400);
    await clickText("Check 14");
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const pending = await js(`document.querySelectorAll('.ux-row.is-pending').length`);
      const rows = await js(`document.querySelectorAll('.ux-row').length`);
      if (rows > 0 && pending === 0) break;
    }
    await sleep(1500);
  };

  // A first start with one setting: the White background. The default, Aura, is a warm
  // paper tone that reads as yellowish in a picture; White is neutral.
  const WHITE = `localStorage.setItem('hproxy-checker-settings', JSON.stringify({ background: 'white', look: 'd-2026-09-23' }))`;
  await navigate(cdp, s, URL, 60_000);
  await js(`localStorage.clear()`);
  await js(WHITE);
  await navigate(cdp, s, URL, 60_000);
  await sleep(1500);

  // Check, with results.
  await runCheck();
  await shoot("check-light.png");
  await setDark(true);
  await shoot("check-dark.png");

  // Use with AI, dark then light.
  await clickText("Use with AI");
  await sleep(1200);
  await shoot("ai-dark.png");
  await setDark(false);
  await shoot("ai-light.png");

  // Connect, connected through a list of three (the preview's own demo).
  await navigate(cdp, s, `${URL}?demo=connect`, 60_000);
  await sleep(3500);
  await shoot("connect-light.png");
  await setDark(true);
  await shoot("connect-dark.png");
  await setDark(false);

  // The phone screens, drawn the way store-screenshots.mjs draws them: the app shows its phone
  // layout when the browser says Android. 360 x 640 at 3x.
  const phone = await newPage(cdp, { width: 360, height: 640 });
  const ps = phone.sessionId;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 3, mobile: true }, ps);
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    platform: "Android",
  }, ps);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, ps);
  cdp.on((m) => {
    if (m.sessionId === ps && m.method === "Runtime.exceptionThrown") problems.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  });
  const pjs = (e) => cdp.evaluate(ps, e);
  const pclick = async (text) => {
    const hit = await pjs(`(() => {
      const b = [...document.querySelectorAll('button,[role=tab],a')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!hit) throw new Error(`phone: nothing to click that says "${text}"`);
  };
  const pshoot = async (name) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, ps);
    writeFileSync(join(RAW, name), Buffer.from(data, "base64"));
    console.log(`raw ${name}`);
  };
  const pdark = async (on) => {
    const title = on ? "Dark mode" : "White mode";
    const hit = await pjs(`(() => { const b = document.querySelector('button[title="${title}"]'); if (!b) return false; b.click(); return true; })()`);
    if (!hit) throw new Error(`phone: no "${title}" switch`);
    await sleep(1000);
  };
  await navigate(cdp, ps, URL, 60_000);
  await pjs(`localStorage.clear()`);
  await pjs(WHITE);
  await navigate(cdp, ps, URL, 60_000);
  await sleep(1500);
  await pclick("Check");
  await sleep(800);
  await pclick("Type them in");
  await sleep(600);
  await pjs(`document.querySelector('textarea[aria-label="Proxy list"]').focus()`);
  await cdp.send("Input.insertText", { text: EXAMPLE_LIST }, ps);
  await sleep(400);
  await pclick("Check 14");
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const pending = await pjs(`document.querySelectorAll('.ux-row.is-pending').length`);
    const rows = await pjs(`document.querySelectorAll('.ux-row').length`);
    if (rows > 0 && pending === 0) break;
  }
  await sleep(1500);
  await pshoot("phone-check.png");
  await pdark(true);
  await pshoot("phone-check-dark.png");
  await navigate(cdp, ps, `${URL}?demo=connect`, 60_000);
  await sleep(3500);
  await pshoot("phone-connect-dark.png");
  await pdark(false);
  await pshoot("phone-connect.png");

  // The angled pictures.
  const compose = pathToFileURL(join(HERE, "marketing-compose.html")).href;
  const scenes = [
    { name: "hero-light", width: 1600, height: 1000 },
    { name: "hero-dark", width: 1600, height: 1000 },
    { name: "fan-dark", width: 1600, height: 1000 },
    { name: "window-dark", width: 1600, height: 1000 },
    { name: "connect-closeup-dark", width: 1600, height: 1000 },
    { name: "window-angled", width: 1400, height: 1000, transparent: true },
    { name: "phones", width: 1200, height: 1200 },
    { name: "phones-dark", width: 1200, height: 1200 },
  ];
  for (const sc of scenes) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: sc.width, height: sc.height, deviceScaleFactor: 2, mobile: false }, s);
    await navigate(cdp, s, `${compose}?scene=${sc.name}&raw=${encodeURIComponent(pathToFileURL(RAW).href)}`, 60_000);
    await js(`document.fonts ? document.fonts.ready.then(() => true) : true`);
    const ok = await js(`Promise.all([...document.images].map((i) => i.complete ? (i.naturalWidth > 0) : new Promise((r) => { i.onload = () => r(true); i.onerror = () => r(false); })))
      .then((all) => all.every(Boolean))`);
    if (!ok) throw new Error(`${sc.name}: an image did not load`);
    await sleep(600);
    if (sc.transparent) await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, s);
    for (const format of ["png", "webp"]) {
      const { data } = await cdp.send("Page.captureScreenshot", format === "webp" ? { format, quality: 88 } : { format }, s);
      writeFileSync(join(OUT, `${sc.name}.${format}`), Buffer.from(data, "base64"));
    }
    if (sc.transparent) await cdp.send("Emulation.setDefaultBackgroundColorOverride", {}, s);
    console.log(`composed ${sc.name}`);
  }
} finally {
  await close();
}
if (problems.length) {
  console.error(`PROBLEMS:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log("no page errors");
}
