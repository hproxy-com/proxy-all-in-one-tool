// marketing-video.mjs: a short film of the app at work, for the website. Run from desktop-app/ with
// the preview server up (npx vite --port 1420):
//   node scripts/marketing-video.mjs [--frames <folder>]
//
// What it shows, as the app does it (the browser preview, its pretend relay and checker), the
// proxy connector first since 2026-10-14:
//   Connect with nothing yet: "Add your proxies", a proxy pasted, its check, Connect. "Reaching the
//   proxy", the page turns blue, the camera dives to the city and the pin stays on it all the way
//   (it stood still while the map slid under it until 0.3.8), the address rolls in. Then a big
//   list on My proxies (2026-10-15): 300 pasted at once, one last day and one note for all of them,
//   added, the "30 days left" chips, Test all, and one of them pressed: the connection switches to
//   it, and Connect shows where it comes out. The switch off, the blue goes back into it. Then the
//   Checker: a list pasted, Check, the rows come in, New check.
//   The recording starts on that empty Checker, after the same steps were taken once off camera,
//   and ends there: the last frame is the first, so the film loops without a seam (checked below).
//   The film starts at the connected page (the loop turned round): the most telling frame is the
//   first one anybody sees, and the poster.
//
// How it is made:
// 1. A clock we move ourselves (film.mjs, CLOCK): the page's timers, animation frames and CSS
//    transitions stand still until the script moves them 40 ms, so every frame is exactly 40 ms
//    after the last, 25 frames a second, however long a capture takes.
// 2. A pointer drawn over the page, moved and pressed by this script, and real mouse events at
//    the same spot, so the page sees hovers and clicks the way it does from a person.
// 3. H.264 by the browser itself (film.mjs, writeFilm), one quantizer per frame: a frame that
//    changes little gets the sharp one, a frame where most of the picture moves (the camera flying
//    over the dot map) a coarser one, where nobody can see the difference; those flights cost most
//    of the file. One keyframe, at the start: a loop only ever goes back there.
// Output: store/marketing/app-in-action.mp4 (1280 x 720) and app-in-action.webp, its poster: the
// film's first frame, so nothing jumps when it starts. Every address on screen is from the ranges
// set aside for examples (RFC 5737). The script fails on any page error.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchWithExtension, newPage, navigate } from "../../chrome-extension/tests/e2e/cdp.mjs";
import { CLOCK, writeFilm } from "./film.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "store", "marketing");
const URL = "http://localhost:1420/";
const W = 1280;
const H = 720;
const FPS = 25;
const STEP = 1000 / FPS;
// H.264 quantizers (lower is sharper and bigger): SHARP for a frame where under 8 % of the pixels
// changed, up to MOVING where 35 % or more did.
const SHARP = 24;
const MOVING = 34;
const framesArg = process.argv.indexOf("--frames");
const FRAMES = framesArg > 0 ? process.argv[framesArg + 1] : null;
// The proxy pasted into Connect: one the preview's check places in Frankfurt (lib/previewConnect.ts
// demoCheckLine reads a line's hash), where its pretend relay comes out too, so the check, the
// pin and the address agree.
const PROXY = "203.0.113.64:3128:user:pass";
const LIST = [
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

// The big list: 300 proxies bought together, one login, each its own address. The preview's
// pretend check (src/lib/preview.ts hashSeed and mulberry32, lib/previewConnect.ts demoCheckLine)
// finds a line dead when the first draw of its seed is under 0.25, and places it at the exit the
// second draw names (the preview's EXITS: Frankfurt, Amsterdam, Ashburn, London), where its
// pretend relay comes out too. A batch bought together answers, so these are 300 that do.
const seedOf = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const draws = (seed) => {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const BATCH = [];
for (const net of ["198.51.100", "203.0.113", "192.0.2"]) {
  for (let i = 1; i <= 254 && BATCH.length < 300; i++) {
    const line = `${net}.${i}:3128:user:pass`;
    if (line !== PROXY && draws(seedOf(line))() >= 0.25) BATCH.push(line);
  }
}
const EXIT_CITIES = ["Frankfurt", "Amsterdam", "Ashburn", "London"];
const exitCity = (line) => {
  const draw = draws(seedOf(line));
  draw();
  return EXIT_CITIES[Math.floor(draw() * EXIT_CITIES.length)];
};
// The one pressed: among the first rows, one that comes out away from Frankfurt, so the
// connection visibly goes somewhere else.
const SWITCH_TO = BATCH.slice(1, 6).find((l) => exitCity(l) !== "Frankfurt") ?? BATCH[1];
const SWITCH_ADDRESS = SWITCH_TO.split(":").slice(0, 2).join(":");
const SWITCH_CITY = exitCity(SWITCH_TO);
// Their last day: 30 days on, typed the way a person types it into the browser's date field
// (month, day, year: the film's browser speaks US English). And their note.
const lastDay = new Date();
lastDay.setDate(lastDay.getDate() + 30);
const LAST_DAY_KEYS = `${String(lastDay.getMonth() + 1).padStart(2, "0")}${String(lastDay.getDate()).padStart(2, "0")}${lastDay.getFullYear()}`;
const NOTE = "Shop batch";

// The pointer, a ring for a click, and the preview's own extras taken out (the real app has
// neither the design picker nor the line that says the relay is pretend). The text caret blinks on
// the browser's real clock, so it would flicker from frame to frame: it is hidden.
const POINTER = String.raw`(() => {
  if (window.__pointer) return;
  const ring = document.createElement("div");
  ring.style.cssText = "position:fixed;left:0;top:0;border:2px solid #fff;border-radius:50%;box-sizing:border-box;z-index:2147483646;pointer-events:none;opacity:0";
  const arrow = document.createElement("div");
  arrow.style.cssText = "position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;pointer-events:none;transform-origin:6px 4px";
  arrow.innerHTML = '<svg width="30" height="30" viewBox="0 0 30 30"><path d="M6 4 L6 24.5 L11.2 19.6 L14.8 27.4 L18.4 25.8 L14.9 18.2 L22 18.2 Z" fill="#0a0a0a" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  const style = document.createElement("style");
  style.textContent = ".ux-designpicker{display:none!important} *{caret-color:transparent!important}";
  document.documentElement.append(style, ring, arrow);
  window.__pointer = {
    draw(x, y, pressed, ringR, ringA) {
      arrow.style.transform = "translate(" + (x - 6) + "px," + (y - 4) + "px) scale(" + (pressed ? 0.86 : 1) + ")";
      ring.style.width = ring.style.height = 2 * ringR + "px";
      ring.style.transform = "translate(" + (x - ringR) + "px," + (y - ringR) + "px)";
      ring.style.opacity = String(ringA);
      for (const p of document.querySelectorAll("p")) if (p.textContent.trim().startsWith("Browser preview:")) p.style.display = "none";
    },
  };
})();`;

mkdirSync(OUT, { recursive: true });
if (FRAMES) mkdirSync(FRAMES, { recursive: true });
// US English: the browser's own date field then reads mm/dd/yyyy, as most of the site's readers see it.
const { cdp, close } = await launchWithExtension({ extensionDir: null, headless: true, extraArgs: ["--lang=en-US", "--accept-lang=en-US"] });
const problems = [];
const shots = []; // every frame, a PNG in base64
let start = 0; // where the film begins: the connected page
try {
  // The app, on the clock, at its first start: dark, the way it opens (src/lib/settings.ts).
  const page = await newPage(cdp, { width: W, height: H });
  const s = page.sessionId;
  cdp.on((m) => {
    if (m.sessionId === s && m.method === "Runtime.exceptionThrown") problems.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  });
  const js = (e) => cdp.evaluate(s, e);
  await navigate(cdp, s, URL, 60_000);
  await js(`localStorage.clear()`);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK }, s);
  await navigate(cdp, s, URL, 60_000);
  await js(POINTER);

  const REST = { x: 1012, y: 566 };
  let at = { ...REST };
  let pressed = false;
  let ring = null;
  // Off camera, every step moves the clock and nothing is kept.
  let rolling = false;
  const step = () => js(`__clock.step(${STEP})`);
  const draw = () => {
    let r = 0, a = 0;
    if (ring) {
      const k = ring.k / 9;
      r = 9 + 21 * k;
      a = Math.max(0, 1 - k);
      if (++ring.k > 9) ring = null;
    }
    return js(`__pointer.draw(${at.x}, ${at.y}, ${pressed}, ${r}, ${a})`);
  };
  const frame = async () => {
    await draw();
    await step();
    if (rolling) shots.push((await cdp.send("Page.captureScreenshot", { format: "png" }, s)).data);
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
  const click = async () => {
    pressed = true;
    await mouse("mousePressed", { clickCount: 1 });
    await frame();
    await frame();
    await mouse("mouseReleased", { clickCount: 1 });
    pressed = false;
    ring = { k: 0 };
  };
  const centre = async (find, dx = 0, dy = 0) => {
    const r = await js(`(() => { const e = ${find}; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (!r) throw new Error(`not on the page: ${find}`);
    return { x: r.x + dx, y: r.y + dy };
  };
  const state = (words) => `document.querySelector('.mix-state')?.textContent === ${JSON.stringify(words)}`;
  const tab = (label) => `document.querySelector('.ux-navseg > .ux-tab[aria-label=${JSON.stringify(label)}]')`;
  const button = (words) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(words)})`;
  const sheetButton = (words) => `[...document.querySelectorAll('.mix-sheet button')].find((b) => b.textContent.trim() === ${JSON.stringify(words)})`;
  const barButton = (words) => `[...document.querySelectorAll('.ux-listbar button')].find((b) => b.textContent.trim() === ${JSON.stringify(words)})`;
  const savedRow = (address) => `[...document.querySelectorAll('.ux-place')].find((r) => r.querySelector('.name')?.textContent.trim() === ${JSON.stringify(address)})`;
  // A key pressed and let go, as a person types into a field the page does not own (the date).
  const key = async (ch) => {
    const k = { key: ch, code: `Digit${ch}`, windowsVirtualKeyCode: 48 + Number(ch) };
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, ...k }, s);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k }, s);
  };

  // A big list on My proxies, while connected: Add, 300 pasted, their last day and note, Add 300,
  // the chips, Test all, one of them pressed (the connection switches to it), then Connect, where
  // it comes out.
  const bigList = async () => {
    await glide(await centre(tab("Proxies")), 700);
    await hold(80);
    await click();
    await hold(640);
    await glide(await centre(barButton("Add")), 620);
    await hold(80);
    await click();
    await hold(420);
    // The list pasted into the field (Ctrl+V, which leaves nothing to see), read at once.
    await js(`(() => {
      const input = document.querySelector('input[aria-label="Proxy line"]');
      input.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(BATCH.join("\n"))});
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    await holdUntil(`/300 ready/.test(document.body.textContent)`, "the pasted list's review");
    await hold(1100);
    // The day goes in from its month: the field's left part.
    await glide(await centre(`document.querySelector('input[type=date]')`, -72), 620);
    await hold(80);
    await click();
    await hold(200);
    for (const ch of LAST_DAY_KEYS) {
      await key(ch);
      await frame();
      await frame();
    }
    await hold(500);
    if (!(await js(`document.querySelector('input[type=date]').value !== ''`))) throw new Error("the last day did not go in");
    await glide(await centre(`document.querySelector('input[aria-label="Note for all of them"]')`, -380), 560);
    await hold(80);
    await click();
    await hold(160);
    for (const ch of NOTE) {
      await cdp.send("Input.insertText", { text: ch }, s);
      await frame();
      await frame();
    }
    await hold(700);
    await glide(await centre(button("Add 300 as proxies")), 600);
    await hold(80);
    await click();
    await holdUntil(`!!${savedRow(SWITCH_ADDRESS)}`, "the list");
    await hold(1300);
    await glide(await centre(barButton("Test all")), 640);
    await hold(80);
    await click();
    await hold(2400);
    // The one pressed: pointed at, it says "Switch here".
    await glide(await centre(`${savedRow(SWITCH_ADDRESS)}?.querySelector('.name')`), 700);
    await hold(360);
    await click();
    await holdUntil(`${savedRow(SWITCH_ADDRESS)}?.classList.contains('is-on')`, "the switch to the pressed proxy");
    await hold(1200);
    await glide(await centre(tab("Connect")), 760);
    await hold(80);
    await click();
    await holdUntil(state("Connected"), "Connect after the switch");
    if (!(await js(`document.body.textContent.includes(${JSON.stringify(SWITCH_CITY)})`))) throw new Error(`Connect does not say ${SWITCH_CITY}`);
    await hold(2000);
  };

  // The Checker, from its empty page to its empty page again: a list pasted, checked, New check.
  // Taken once off camera before the film and once at its end, so both ends are the same frame.
  const checker = async () => {
    await glide(await centre(tab("Checker")), 680);
    await hold(80);
    await click();
    await hold(560);
    await glide(await centre(`document.querySelector('textarea')`, -380, -90), 560);
    await click();
    await hold(240);
    await js(`document.querySelector('textarea').focus()`);
    await cdp.send("Input.insertText", { text: LIST }, s);
    await hold(480);
    await glide(await centre(`[...document.querySelectorAll('button')].find((b) => /^Check \\d+$/.test(b.textContent.trim()))`), 560);
    await hold(80);
    await click();
    await holdUntil(`document.querySelectorAll('.ux-row').length > 0 && document.querySelectorAll('.ux-row.is-pending').length === 0`, "the check");
    await hold(1500);
    await glide(await centre(button("New check")), 640);
    await hold(80);
    await click();
    await hold(400);
    await glide(REST, 640);
    await mouse("mouseMoved");
    await hold(360);
  };

  // Off camera: the app at its first start (Connect, nothing kept yet), then the Checker's round.
  await draw();
  for (let i = 0; i < 40; i++) await step();
  if (!(await js(`!!document.querySelector('.mix-place')`))) throw new Error("the app did not open on Connect");
  await mouse("mouseMoved");
  await checker();

  // The film. Its first frame is the pointer at rest, as its last one is.
  rolling = true;
  await hold(STEP);
  await glide(await centre(tab("Connect")), 700);
  await hold(80);
  await click();
  await hold(480);
  if (!(await js(`document.querySelector('.mix-place')?.textContent.includes('Add your proxies')`))) throw new Error("Connect already has a proxy");
  await glide(await centre(`document.querySelector('.mix-place')`), 640);
  await hold(80);
  await click();
  await hold(520);
  await glide(await centre(`document.querySelector('.mix-sheet input')`, -110, 2), 560);
  await click();
  await hold(200);
  await js(`document.querySelector('.mix-sheet input').focus()`);
  await cdp.send("Input.insertText", { text: PROXY }, s);
  await holdUntil(`/Working/.test(document.querySelector('.mix-sheet')?.textContent ?? '')`, "the pasted proxy's check");
  await hold(700);
  await glide(await centre(sheetButton("Connect")), 520);
  await hold(80);
  await click();
  await holdUntil(state("Connected"), "the connection");
  await hold(2200);
  start = shots.length;
  await hold(900);
  await bigList();
  await glide(await centre(`document.querySelector('.mix-knob')`), 620);
  await hold(100);
  await click();
  await holdUntil(state("Not connected"), "the disconnection");
  await hold(700);
  await checker();

  const errors = await js(`__clock.errors`);
  if (errors.length) problems.push(...errors);

  // The loop turned round: from the connected page to the end, then the start up to it. The last
  // frame and the first show the same thing (the empty Checker, the pointer at rest), so the join
  // is seamless. The encoder page is the preview's own address: WebCodecs needs a secure page.
  const said = await writeFilm(cdp, {
    coderUrl: `${URL}@vite/client`,
    shots,
    start,
    width: W,
    height: H,
    fps: FPS,
    sharp: SHARP,
    moving: MOVING,
    mp4File: join(OUT, "app-in-action.mp4"),
    posterFile: join(OUT, "app-in-action.webp"),
    framesDir: FRAMES,
    problems,
  });
  console.log(`app-in-action.mp4: ${said}`);
} finally {
  await close();
}
if (problems.length) {
  console.error(`PROBLEMS:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log("no page errors");
}
