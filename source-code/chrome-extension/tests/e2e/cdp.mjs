/* ============================================================
   A small Chrome DevTools Protocol client, no dependencies.

   Node 22 ships WebSocket, so driving Chrome needs nothing from npm.
   Used by real-browser.mjs (the end-to-end run) and by
   scripts/preview.mjs (a window with the extension, for looking at it).

   ⚠️ Always Chrome for TESTING, never the installed Google Chrome:
     - Google Chrome 137+ ignores --load-extension; Chrome for Testing
       still honours it.
     - A bare chrome.exe without its own --user-data-dir attaches to the
       Chrome the person is using and can open a window in THEIR session.
       Every launch here passes its own profile folder.
   ============================================================ */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The newest Chrome for Testing that puppeteer has downloaded, or CHROME_PATH. */
export function findChromeForTesting() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(homedir(), ".cache", "puppeteer", "chrome");
  if (!existsSync(base)) {
    throw new Error(`No Chrome for Testing under ${base}. Run: npx @puppeteer/browsers install chrome@stable, or set CHROME_PATH.`);
  }
  const version = (dir) => (dir.split("-")[1] || "0").split(".").map(Number);
  const newestFirst = readdirSync(base).sort((a, b) => {
    const [x, y] = [version(a), version(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    }
    return 0;
  });
  for (const dir of newestFirst) {
    const candidates = [
      join(base, dir, "chrome-win64", "chrome.exe"),
      join(base, dir, "chrome-linux64", "chrome"),
      join(base, dir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      join(base, dir, "chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
    ];
    const found = candidates.find((p) => existsSync(p));
    if (found) return found;
  }
  throw new Error(`No Chrome for Testing binary found under ${base}.`);
}

/** The id Chrome gives an unpacked extension whose manifest carries `key`. */
export function extensionIdFromKey(base64Key) {
  const hex = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id !== undefined) {
        const waiting = this.pending.get(msg.id);
        if (!waiting) return;
        this.pending.delete(msg.id);
        clearTimeout(waiting.timer);
        if (msg.error) waiting.reject(new Error(`${waiting.method}: ${msg.error.message}`));
        else waiting.resolve(msg.result);
        return;
      }
      for (const listener of this.listeners) listener(msg);
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  /** Every event, for as long as the returned function is not called. */
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The first event matching `match`, or null after `timeoutMs`. */
  waitFor(match, timeoutMs) {
    return new Promise((resolve) => {
      const off = this.on((msg) => {
        if (!match(msg)) return;
        off();
        clearTimeout(timer);
        resolve(msg);
      });
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return sessionId;
  }

  /** Run an expression in a target and return its value. Throws what the page threw. */
  async evaluate(sessionId, expression, timeoutMs = 60_000) {
    const r = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
      timeoutMs,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "evaluate failed");
    }
    return r.result?.value;
  }
}

/**
 * Start Chrome for Testing with the unpacked extension and connect to it.
 * `profileDir` omitted = a fresh throwaway profile, deleted by close().
 */
export async function launchWithExtension({ extensionDir, headless = true, profileDir, extraArgs = [], startUrl = "about:blank" }) {
  const exe = findChromeForTesting();
  const throwaway = !profileDir;
  const dir = profileDir || mkdtempSync(join(tmpdir(), "hproxy-ext-e2e-"));
  const portFile = join(dir, "DevToolsActivePort");
  rmSync(portFile, { force: true });

  const args = [
    `--user-data-dir=${dir}`,
    ...(extensionDir ? [`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`] : []),
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    ...(headless ? ["--headless=new"] : []),
    ...extraArgs,
    startUrl,
  ];
  // stdio "ignore": a child that inherits our pipes keeps a caller waiting
  // after we exit (the Windows trap written up in the checker's AGENTS.md).
  const proc = spawn(exe, args, { stdio: "ignore" });

  const deadline = Date.now() + 30_000;
  while (!existsSync(portFile)) {
    if (proc.exitCode !== null) throw new Error(`Chrome exited early with code ${proc.exitCode}`);
    if (Date.now() > deadline) throw new Error("Chrome did not open its DevTools port within 30 s");
    await new Promise((r) => setTimeout(r, 100));
  }
  let lines = [];
  while (lines.length < 2) {
    lines = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    if (lines.length < 2) await new Promise((r) => setTimeout(r, 50));
  }
  const ws = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("DevTools socket failed to open")), { once: true });
  });
  const cdp = new CDP(ws);

  async function close() {
    try {
      await cdp.send("Browser.close", {}, undefined, 5_000);
    } catch {
      /* already gone */
    }
    const exited = await new Promise((r) => {
      if (proc.exitCode !== null) return r(true);
      const t = setTimeout(() => r(false), 8_000);
      proc.once("exit", () => {
        clearTimeout(t);
        r(true);
      });
    });
    if (!exited) proc.kill();
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    if (throwaway) {
      // Windows can hold a profile file for a moment after exit.
      for (let i = 0; i < 20; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
  }

  return { cdp, proc, profileDir: dir, close };
}

/** Wait until the extension's service worker exists and attach to it. */
export async function attachServiceWorker(cdp, extensionId, timeoutMs = 20_000) {
  const url = `chrome-extension://${extensionId}/background.js`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url === url);
    if (sw) {
      const sessionId = await cdp.attach(sw.targetId);
      await cdp.send("Runtime.enable", {}, sessionId);
      return { targetId: sw.targetId, sessionId };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`The extension's service worker (${url}) never started`);
}

/** A new tab, attached, with Page + Runtime + Network events on. */
export async function newPage(cdp, { width = 1200, height = 800 } = {}) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const sessionId = await cdp.attach(targetId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  return { targetId, sessionId };
}

/** Navigate and wait for load. Returns { ok, error } without throwing on network errors. */
export async function navigate(cdp, sessionId, url, timeoutMs = 25_000) {
  const loaded = cdp.waitFor((m) => m.sessionId === sessionId && m.method === "Page.loadEventFired", timeoutMs);
  let r;
  try {
    r = await cdp.send("Page.navigate", { url }, sessionId, timeoutMs);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (r.errorText) return { ok: false, error: r.errorText };
  const ev = await loaded;
  return ev ? { ok: true, error: null } : { ok: false, error: "no load event (timeout)" };
}
