// The time zone match, end to end, in the real app on this computer (Windows).
//
// Runs a debug build made with its own identifier, so it runs beside an
// installed HProxy and shares none of its data (settings, saved proxies, the
// single-instance lock), hidden in the tray, and drives it through WebView2's
// debugging port on 127.0.0.1. Nothing is clicked, no window opens, and the
// system proxy is never set (every connect passes systemProxy: false).
//
//   npx tauri build --debug --no-bundle --config '{"identifier":"com.hproxy.checker.e2e"}'
//   node scripts/e2e-timezone.mjs
//
// What it proves, against Windows' own tzutil:
//   1. matching on, then a connect: the probe loop matches the zone to the exit,
//      and the app's own webview reads the new zone (browsers follow);
//   2. the app killed while matched (a crash): the record is on disk, and the
//      next start puts the zone back before anything else;
//   3. a connect, then matching on: matched at once; a disconnect puts it back.
// Whatever happens, the zone this computer had goes back at the end.
//
// Written 2026-09-29 and NOT RUN YET: 0.2.8 went out without it.
// Run it once, and fix what it finds, before trusting a pass from it.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ID = "com.hproxy.checker.e2e";
const EXE = process.env.E2E_EXE ?? join(ROOT, "target", "debug", "hproxy-checker.exe");
const PORT = 9333;
const TZUTIL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tzutil.exe");
const RECORD = join(process.env.APPDATA, ID, "timezone-snapshot.json");
const LOG = join(process.env.LOCALAPPDATA, ID, "logs", "hproxy-checker.log");
const COUNTRIES = ["US", "CA", "BR", "JP", "SG", "IN", "GB"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zoneNow = () => execFileSync(TZUTIL, ["/g"], { encoding: "utf8" }).trim();
const setZone = (z) => execFileSync(TZUTIL, ["/s", z]);
const say = (s) => console.log(`  ${s}`);
let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures += 1;
}

/** Minutes east of UTC that an IANA zone shows now. */
function offsetOf(zone) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value;
  const m = part?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  return part === "GMT" ? 0 : m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : null;
}

let app = null;
function launch() {
  app = spawn(EXE, ["--background"], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
    windowsHide: true,
  });
  return app;
}
function kill() {
  if (app && app.exitCode === null) {
    try {
      process.kill(app.pid);
    } catch {
      /* gone already */
    }
  }
  app = null;
}

/** The page of the app's webview, over the Chrome DevTools Protocol. */
async function connectPage() {
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === "page");
    } catch {
      /* not up yet */
    }
    if (!target) await sleep(500);
  }
  if (!target) throw new Error("the app's webview never opened its debugging port");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) {
      waiting.get(d.id)(d);
      waiting.delete(d.id);
    }
  };
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const d = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const ex = d.result?.exceptionDetails;
    if (ex) throw new Error(ex.exception?.description ?? ex.text);
    return d.result?.result?.value;
  };
  const invoke = (cmd, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  // The screens are up (past the start gate), and App.tsx has told the Rust
  // side the saved setting, so what the test sets next is not overwritten.
  for (let i = 0; i < 60; i++) {
    if (await evaluate("!!window.__TAURI_INTERNALS__ && document.body.innerText.includes('Settings')").catch(() => false)) break;
    await sleep(500);
  }
  await sleep(1500);
  return { evaluate, invoke, close: () => ws.close() };
}

/** Connect through a free exit in a zone other than this computer's; the status once its probe answered. */
async function connectElsewhere(page, before) {
  for (const country of COUNTRIES) {
    say(`connecting through a free ${country} proxy…`);
    try {
      await page.invoke("connect_start", { source: { kind: "free", country, socks5: false }, listen: null, systemProxy: false, probeUrl: null });
    } catch (e) {
      say(`no ${country} exit: ${e.message ?? e}`);
      continue;
    }
    for (let i = 0; i < 45; i++) {
      const s = await page.invoke("connect_status");
      const h = s.health;
      if (h?.ok && h.timezone) {
        if (offsetOf(h.timezone) !== offsetOf(before)) return s;
        say(`the exit is in ${h.timezone}, the same time as here: another country`);
        break;
      }
      await sleep(1000);
    }
    await page.invoke("connect_stop").catch(() => {});
  }
  throw new Error("no free exit answered in another time zone");
}

const original = zoneNow();
const localIana = Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log(`this computer: ${original} (${localIana})`);
if (!existsSync(EXE)) throw new Error(`build it first: ${EXE}`);

try {
  rmSync(RECORD, { force: true });

  // 1. Matching on, then a connect: the probe loop matches.
  console.log("\n1. matching on, then a connect");
  launch();
  let page = await connectPage();
  const off = await page.invoke("timezone_status");
  check(off.supported === true && off.matching === false && !off.matched, "Windows is supported, the matching starts off");
  await page.invoke("timezone_set_matching", { on: true });
  let s = await connectElsewhere(page, localIana);
  const exitZone = s.health.timezone;
  say(`connected, the exit is in ${exitZone} (${s.health.country_code})`);
  let zone = null;
  for (let i = 0; i < 20 && !zone?.matched; i++) {
    zone = await page.invoke("timezone_status");
    if (!zone.matched) await sleep(500);
  }
  check(!!zone?.matched && !zone.problem, `matched after the probe: ${zone?.matched ?? zone?.problem ?? "nothing"}`);
  check(zoneNow() === zone?.matched, `Windows shows it: ${zoneNow()}`);
  let seen = null;
  for (let i = 0; i < 30; i++) {
    seen = await page.evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone");
    if (offsetOf(seen) === offsetOf(exitZone)) break;
    await sleep(500);
  }
  check(offsetOf(seen) === offsetOf(exitZone), `the app's own webview reads the new zone: ${seen}`);
  const record = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : null;
  check(record?.before === original && record?.ours === zone?.matched, `the record is on disk: ${JSON.stringify(record)}`);

  // 2. A crash while matched: the next start puts it back.
  console.log("\n2. the app killed while matched");
  page.close();
  kill();
  await sleep(1500);
  check(zoneNow() === zone?.matched, `after the kill the zone is still the exit's: ${zoneNow()}`);
  launch();
  page = await connectPage();
  check(zoneNow() === original, `the next start put it back: ${zoneNow()}`);
  check(!existsSync(RECORD), "and removed the record");

  // 3. A connect, then matching on; then a disconnect.
  console.log("\n3. a connect, then matching on, then a disconnect");
  s = await connectElsewhere(page, localIana);
  say(`connected, the exit is in ${s.health.timezone}`);
  zone = await page.invoke("timezone_set_matching", { on: true });
  check(!!zone.matched && zoneNow() === zone.matched, `matched at once: ${zone.matched ?? zone.problem}`);
  const stopped = await page.invoke("connect_stop");
  check(zoneNow() === original, `the disconnect put it back: ${zoneNow()}${stopped.notice ? ` (${stopped.notice})` : ""}`);
  zone = await page.invoke("timezone_status");
  check(!zone.matched && !existsSync(RECORD), "nothing matched, no record left");
  await page.invoke("timezone_set_matching", { on: false });
  page.close();
} catch (e) {
  failures += 1;
  console.log(`FAIL  ${e.message ?? e}`);
} finally {
  kill();
  await sleep(1000);
  if (zoneNow() !== original) {
    setZone(original);
    console.log(`(the zone was put back by the test's own guard: ${zoneNow()})`);
  }
  if (existsSync(LOG)) {
    console.log("\nthe test app's log:");
    for (const l of readFileSync(LOG, "utf8").split(/\r?\n/).filter((l) => /time zone|timezone/i.test(l))) console.log(`  ${l}`);
  }
  if (!process.env.E2E_KEEP) {
    rmSync(join(process.env.APPDATA, ID), { recursive: true, force: true });
    rmSync(join(process.env.LOCALAPPDATA, ID), { recursive: true, force: true });
  }
  console.log(`\n${failures ? `${failures} FAILED` : "all passed"}; this computer: ${zoneNow()}`);
  process.exit(failures ? 1 : 0);
}
