/* ============================================================
   power-video.mjs: the power button moving, as a video (and stills).

     node scripts/power-video.mjs <output folder>                 power.mp4
     node scripts/power-video.mjs <output folder> --stills        off, connecting, on

   The real popup of THIS folder in Chrome for Testing (never the browser in
   use: tests/e2e/cdp.mjs), with a stand-in for the background worker that
   answers its messages from a script: a connect that takes 1.8 s, then a
   disconnect. So every run moves the same way, and the only address on
   screen is an example one. Off for a moment, a press, connecting, on for
   five seconds, a press, off.

   The video is the top of the popup only, recorded at twice its size
   (the page itself is zoomed: the screencast hands frames over at the
   page's own size, whatever the device scale), about 80 frames a second,
   written by ffmpeg as 60 frames a second H.264.
   ============================================================ */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey, launchWithExtension, navigate, newPage } from "../tests/e2e/cdp.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const OUT = resolve(ARGS.find((a) => !a.startsWith("--")) || join(EXT, "dist", "power"));
const STILLS = ARGS.includes("--stills");
mkdirSync(OUT, { recursive: true });
const ID = extensionIdFromKey(JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")).key);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The stand-in worker, in place before the popup's own script runs. */
const STAND_IN = `(() => {
  if (!globalThis.chrome?.runtime) return;
  const state = { active: null, searching: false };
  const listeners = [];
  const changed = () => listeners.forEach((fn) => { try { fn({ type: "statusChanged" }); } catch {} });
  chrome.runtime.onMessage.addListener = (fn) => listeners.push(fn);
  const exit = { mode: "vpn", scheme: "socks5", host: "192.0.2.61", port: 1080, label: "US", exitIp: "203.0.113.24",
    country: "US", auth: false, failing: false, verified: true, rechecking: false, loginRefused: false, hijacked: false, policy: false };
  chrome.runtime.sendMessage = (msg, cb) => {
    const reply = (v) => setTimeout(() => cb && cb(v), 0);
    switch (msg && msg.type) {
      case "status": return reply({ ok: true, active: state.active, searching: state.searching, testing: false });
      case "vpnConnect":
        state.searching = true;
        changed();
        return setTimeout(() => { state.searching = false; state.active = { ...exit }; cb && cb({ ok: true, active: state.active }); changed(); }, 1800);
      case "disconnect":
        state.active = null;
        changed();
        return reply({ ok: true, active: null });
      default: return reply({ ok: true });
    }
  };
})();`;

const { cdp, close } = await launchWithExtension({ extensionDir: EXT, headless: true, extraArgs: ["--lang=en-US", "--accept-lang=en-US"] });
try {
  const { sessionId: s } = await newPage(cdp, { width: 384, height: 600 });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 384, height: 600, deviceScaleFactor: 2, mobile: false }, s);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: STAND_IN }, s);
  const js = (e) => cdp.evaluate(s, e);
  const popup = `chrome-extension://${ID}/popup.html`;
  await navigate(cdp, s, popup, 30_000);
  // Nothing kept and no last place: the button goes to the fastest free proxy.
  await js(`chrome.storage.local.clear()`);
  await navigate(cdp, s, popup, 30_000);
  await sleep(1500);
  const top = await js(`(() => { const r = document.getElementById("conn").getBoundingClientRect(); const b = document.getElementById("connSwitch").getBoundingClientRect(); return { h: Math.ceil(r.height), x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);

  const Z = STILLS ? 1 : 2;
  if (STILLS) await cdp.send("Emulation.setDeviceMetricsOverride", { width: 384, height: top.h, deviceScaleFactor: 2, mobile: false }, s);
  else {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 384 * Z, height: top.h * Z, deviceScaleFactor: 1, mobile: false }, s);
    await js(`document.documentElement.style.zoom = "${Z}"`);
  }
  await sleep(400);
  if (!(await js(`!!document.elementFromPoint(${top.x * Z}, ${top.y * Z})?.closest("#connSwitch")`))) throw new Error("the pointer would miss the power button");

  const at = { x: top.x * Z, y: top.y * Z };
  const press = async () => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at }, s);
    await sleep(120);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 }, s);
    await sleep(110);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 }, s);
    await sleep(260);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 10 }, s);
  };
  const name = "power";

  if (STILLS) {
    const shot = async (label) => {
      const r = await cdp.send("Page.captureScreenshot", { format: "png" }, s);
      const file = join(OUT, `${name}-${label}.png`);
      writeFileSync(file, Buffer.from(r.data, "base64"));
      console.log(file);
    };
    await shot("1-off");
    await press();
    await sleep(500);
    await shot("2-connecting");
    await sleep(2200);
    await shot("3-on");
  } else {
    const frames = [];
    cdp.listeners.add((m) => {
      if (m.sessionId !== s || m.method !== "Page.screencastFrame") return;
      frames.push({ data: m.params.data, t: m.params.metadata.timestamp });
      cdp.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, s).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 }, s);
    await sleep(1200);
    await press();
    await sleep(5600);
    await press();
    await sleep(1800);
    await cdp.send("Page.stopScreencast", {}, s);
    await sleep(300);

    // Each frame shown for as long as it was on screen, then 60 frames a second.
    const dir = join(OUT, `${name}-frames`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const list = [];
    frames.forEach((f, i) => {
      const file = join(dir, `f${String(i).padStart(5, "0")}.png`).replace(/\\/g, "/");
      writeFileSync(file, Buffer.from(f.data, "base64"));
      const next = frames[i + 1];
      list.push(`file '${file}'`, `duration ${next ? Math.max(0.001, next.t - f.t).toFixed(4) : "0.5"}`);
      if (!next) list.push(`file '${file}'`);
    });
    writeFileSync(join(dir, "list.txt"), list.join("\n"));
    const span = frames.length > 1 ? frames.at(-1).t - frames[0].t : 0;
    const mp4 = join(OUT, `${name}.mp4`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"),
      "-vf", "fps=60,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "16",
      "-preset", "slow", "-movflags", "+faststart", mp4]);
    rmSync(dir, { recursive: true, force: true });
    console.log(`${frames.length} frames over ${span.toFixed(2)} s (${(frames.length / span).toFixed(0)} a second): ${mp4}`);
  }
} finally {
  await close();
}
