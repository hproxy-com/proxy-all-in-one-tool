// The country flags of the phone app (app/src/main/assets/flags/<cc>.webp),
// drawn from the website's own flag set (the flag-icons collection, MIT) at
// the size the app shows them, as small WebP
// pictures: Android draws no SVG, and one picture per flag is loaded only when
// a flag is on the screen.
//
// Drawn in a separate headless Chrome for Testing with a throwaway profile
// (never the everyday browser), over the DevTools protocol with Node's own
// WebSocket. Run it again when the website's flags change:
//
//   node phone-android/tools/gen-flags.mjs <flags folder> [chrome.exe]
//
// Every flag is 4:3; 120 x 90 pixels keeps the biggest one the app shows
// (40 x 30 dp) sharp on a phone with three pixels per dp.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [flagsDir, chromeArg] = process.argv.slice(2);
if (!flagsDir) {
  console.error("usage: node gen-flags.mjs <flags folder> [chrome.exe]");
  process.exit(2);
}
const CHROME = chromeArg || process.env.CHROME;
if (!CHROME) {
  console.error("Chrome for Testing is needed: pass its chrome.exe, or set CHROME");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "app", "src", "main", "assets", "flags");
const W = 120;
const H = 90;
const QUALITY = 0.86;

const codes = readdirSync(flagsDir)
  .filter((f) => f.endsWith(".svg"))
  .map((f) => f.slice(0, -4));

// The flags, served for this run only.
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname).slice(1);
  if (name === "draw.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><meta charset=utf-8><body></body>");
    return;
  }
  try {
    const body = readFileSync(join(flagsDir, name));
    res.writeHead(200, { "content-type": "image/svg+xml" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const served = `http://127.0.0.1:${server.address().port}`;

const profile = join(process.env.TEMP || "C:/Windows/Temp", `cft-flags-${process.pid}`);
const port = 9300 + (process.pid % 300);
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
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
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  await send("Page.enable");
  await send("Page.navigate", { url: `${served}/draw.html` });
  await sleep(600);

  const script = `(async () => {
    const out = {};
    const c = document.createElement("canvas");
    c.width = ${W}; c.height = ${H};
    const g = c.getContext("2d");
    for (const cc of ${JSON.stringify(codes)}) {
      const img = new Image();
      img.src = "/" + cc + ".svg";
      try { await img.decode(); } catch { continue; }
      g.clearRect(0, 0, ${W}, ${H});
      g.drawImage(img, 0, 0, ${W}, ${H});
      out[cc] = c.toDataURL("image/webp", ${QUALITY});
    }
    return JSON.stringify(out);
  })()`;
  const r = await send("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true });
  const drawn = JSON.parse(r.result.result.value);
  mkdirSync(out, { recursive: true });
  let bytes = 0;
  for (const [cc, url] of Object.entries(drawn)) {
    const body = Buffer.from(url.split(",")[1], "base64");
    writeFileSync(join(out, `${cc}.webp`), body);
    bytes += body.length;
  }
  console.log(`${Object.keys(drawn).length} of ${codes.length} flags, ${Math.round(bytes / 1024)} KB, in ${out}`);
  ws.close();
} finally {
  chrome.kill();
  server.close();
  await sleep(400);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
