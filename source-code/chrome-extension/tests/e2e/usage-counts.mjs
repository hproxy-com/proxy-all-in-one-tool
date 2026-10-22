/* ============================================================
   THE USAGE COUNTS: ASKED ONCE, NOTHING BEFORE A YES.

     node tests/e2e/usage-counts.mjs

   The popup in Chrome for Testing (a throwaway profile, never anyone's
   Chrome):
     1. a new copy asks, and has counted and written nothing;
     2. a yes makes the copy's number and counts this opening;
     3. a finished day goes to hproxy.com/v1/app/usage once, in the
        server's shape, and the footer's panel shows it as it went
        (the request is answered here by the test: nothing reaches the
        real server);
     4. off deletes the number and every count, sends nothing more, and
        the question does not come back.

   Exit code 0 when every check passed, 1 otherwise.
   ============================================================ */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachServiceWorker, extensionIdFromKey, launchWithExtension, navigate, newPage } from "./cdp.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const ID = extensionIdFromKey(manifest.key);
const POPUP = `chrome-extension://${ID}/${manifest.action?.default_popup || "popup.html"}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (back) => {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** JSON with every object's keys in order: Chrome's storage gives them back sorted. */
const same = (a, b) => {
  const canon = (v) =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
};

let failed = 0;
const check = (ok, what, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

const { cdp, close } = await launchWithExtension({ extensionDir: EXT, headless: true });
try {
  const page = await newPage(cdp, { width: 380, height: 640 });
  const s = page.sessionId;
  const js = (e) => cdp.evaluate(s, e);
  const book = async () => JSON.parse(await js(`chrome.storage.local.get("hproxy_usage").then((o) => JSON.stringify(o.hproxy_usage ?? null))`));
  const shown = (id) => js(`!document.getElementById(${JSON.stringify(id)}).hidden`);

  // Every report the worker sends is answered here, and kept to look at.
  const sw = await attachServiceWorker(cdp, ID);
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://hproxy.com/v1/app/usage*" }] }, sw.sessionId);
  const posted = [];
  cdp.on((m) => {
    if (m.sessionId !== sw.sessionId || m.method !== "Fetch.requestPaused") return;
    posted.push({ method: m.params.request.method, body: JSON.parse(m.params.request.postData || "null") });
    void cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 204, responseHeaders: [] }, sw.sessionId).catch(() => {});
  });

  // 1. A new copy.
  await navigate(cdp, s, POPUP);
  await js(`chrome.storage.local.clear().then(() => true)`);
  await navigate(cdp, s, POPUP);
  await sleep(1500);
  check(await shown("usageAsk"), "a new copy asks", null);
  check(!(await shown("usageLink")), "and has no switch in the footer before an answer", null);
  check((await book()) === null, "and has counted and written nothing", await book());

  // 2. Yes.
  await js(`document.getElementById("usageYes").click(); true`);
  await sleep(800);
  let b = await book();
  check(b?.answer === "yes" && /^[0-9a-f]{32}$/.test(b?.copy || ""), "a yes makes the copy's random number", b);
  check((b?.days?.[day(0)]?.opened ?? 0) >= 1, "and counts this opening", b?.days);
  check(!(await shown("usageAsk")), "the question goes", null);
  check((await js(`document.getElementById("usageLink").textContent`)) === "Usage counts: on", "the footer says on", await js(`document.getElementById("usageLink").textContent`));
  check(posted.length === 0, "nothing is sent for a day that is not over", posted);

  // 3. A finished day goes, once.
  const copy = b.copy;
  const yesterday = day(1);
  await js(`chrome.storage.local.set(${JSON.stringify({
    hproxy_usage: {
      answer: "yes",
      copy,
      days: { [yesterday]: { opened: 2, connectsOk: 3, failed: { timeout: 1 }, checkRuns: 0, checkMost: 0, saved: 4, groups: 0, free: 1, features: ["free", "search"], crashes: {} } },
      sent: [],
      last: null,
    },
    hproxy_byo: [{ host: "198.51.100.7", port: 8080, label: "198.51.100.7:8080" }],
  })}).then(() => true)`);
  await navigate(cdp, s, POPUP); // the popup's "look" sends what is due
  await sleep(2500);
  check(posted.length === 1 && posted[0].method === "POST", "one report went", posted);
  check(
    JSON.stringify(posted[0]?.body) ===
      JSON.stringify({
        copy,
        app: "extension",
        os: posted[0]?.body?.os,
        version: manifest.version,
        day: yesterday,
        opened: 2,
        connects: { ok: 3, failed: { timeout: 1 } },
        checks: { runs: 0, proxies: "0" },
        saved: "2-10",
        groups: 0,
        free: 1,
        features: ["free", "search"],
        crashes: {},
      }),
    "in the server's shape, counts only",
    posted[0]?.body,
  );
  check(["windows", "macos", "linux", "chromeos", "android", "other"].includes(posted[0]?.body?.os), "the system in the server's words", posted[0]?.body?.os);
  b = await book();
  check(b?.sent?.includes(yesterday) && same(b?.last, posted[0]?.body), "kept as sent, and never again", b);
  await navigate(cdp, s, POPUP);
  await sleep(2000);
  check(posted.length === 1, "an opening later sends nothing twice", posted.length);
  await js(`document.getElementById("usageLink").click(); true`);
  await sleep(300);
  const last = await js(`document.getElementById("usageLast").textContent`);
  check(last.includes(`"day": "${yesterday}"`) && (await shown("usagePanel")), "the footer's panel shows the report as it went", last);

  // 4. Off.
  await js(`(() => { const box = document.getElementById("usageOn"); box.click(); return true; })()`);
  await sleep(800);
  b = await book();
  check(b?.answer === "no" && !b?.copy && Object.keys(b?.days ?? {}).length === 0 && b?.last === null, "off deletes the number and every count", b);
  await js(`chrome.storage.local.set({ hproxy_usage: Object.assign(${JSON.stringify(b)}, { days: { "${day(2)}": { opened: 5 } } }) }).then(() => true)`);
  await navigate(cdp, s, POPUP);
  await sleep(2000);
  check(posted.length === 1, "and nothing is sent after a no", posted.length);
  check(!(await shown("usageAsk")), "the question does not come back", null);
  check((await js(`document.getElementById("usageLink").textContent`)) === "Usage counts: off", "the footer says off", null);
} finally {
  await close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nevery check passed");
process.exit(failed ? 1 : 0);
