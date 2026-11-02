/* ============================================================
   WHICH SITES USE THE PROXY, AND MOVING ON.

     node tests/e2e/advanced.mjs

   The extension in Chrome for Testing (a throwaway profile, never anyone's
   Chrome), connected through test proxies on this machine:
     1. all except some: Chrome's bypass list carries them;
     2. only some: Chrome runs our script, and the popup does not take that
        for another extension holding the proxy;
     3. a site that covers the connection's own test is left out of the list,
        or a dead proxy would pass it;
     4. a wrong word is refused, and the rule stays as it was;
     5. a proxy that stops moves to the next saved one that works.

   Exit code 0 when every check passed, 1 otherwise.
   ============================================================ */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey, launchWithExtension, navigate, newPage } from "./cdp.mjs";
import { startTestProxy } from "./test-proxy.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const POPUP = `chrome-extension://${extensionIdFromKey(manifest.key)}/popup.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (ok, what, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

const { cdp, close } = await launchWithExtension({ extensionDir: EXT, headless: true });
const first = await startTestProxy();
const second = await startTestProxy();
try {
  const popup = await newPage(cdp, { width: 380, height: 640 });
  const browse = await newPage(cdp, { width: 800, height: 600 });
  const js = (e) => cdp.evaluate(popup.sessionId, e);
  const ask = (message) => js(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  const status = async () => (await ask({ type: "status" }))?.active ?? null;
  const setting = () => js(`new Promise((r) => chrome.proxy.settings.get({}, (d) => r(d.value)))`);
  await navigate(cdp, popup.sessionId, POPUP);
  await sleep(800);

  const proxy = (p) => ({ host: "127.0.0.1", port: p.port, username: "", password: "", scheme: "http" });
  const found = await ask({ type: "pinFind", proxy: proxy(first), schemes: ["http"] });
  check(!!found?.found?.exitIp, "the test proxy answers", found);
  await ask({ type: "pinConnect", proxy: proxy(first), verified: true, exitIp: found?.found?.exitIp, country: found?.found?.country, label: "first" });
  await sleep(500);

  // 1. All except some.
  let r = await ask({ type: "sitesSet", mode: "except", text: "example.com\n192.0.2.7" });
  check(r?.ok, "a rule is taken", r);
  let s = await setting();
  check(s?.mode === "fixed_servers" && s.rules.bypassList.includes("*.example.com") && s.rules.bypassList.includes("192.0.2.7"), "Chrome's bypass list carries the sites", s);

  // 2. Only some.
  r = await ask({ type: "sitesSet", mode: "only", text: "example.com" });
  s = await setting();
  check(s?.mode === "pac_script", "only these: Chrome runs our script", s);
  const on = await status();
  check(on && !on.hijacked && on.inEffect, "and it is not taken for another extension", on);

  // 3. The connection's own test stays on the proxy.
  r = await ask({ type: "sitesSet", mode: "except", text: "hproxy.com example.org" });
  s = await setting();
  check(!s?.rules?.bypassList.includes("*.hproxy.com") && s?.rules?.bypassList.includes("*.example.org"), "what covers the test is left out", s?.rules?.bypassList);

  // 4. A wrong word.
  r = await ask({ type: "sitesSet", mode: "except", text: "banana" });
  check(r?.ok === false && /banana/.test(r.error), "a wrong word is refused, by name", r);
  const kept = await ask({ type: "sitesGet" });
  check(kept?.text === "hproxy.com example.org", "and the rule stays", kept);
  await ask({ type: "sitesSet", mode: "all", text: "" });

  // 5. Moving on.
  await js(`chrome.storage.local.set({ hproxy_byo: ${JSON.stringify([proxy(first), proxy(second)])} }).then(() => true)`);
  await ask({ type: "moveOnSet", on: true });
  await first.close();
  const from = Date.now();
  let moved = null;
  while (Date.now() - from < 60000) {
    await navigate(cdp, browse.sessionId, `https://example.com/?${Date.now()}`, 6000).catch(() => {});
    const now = await status();
    if (now && Number(now.port) === second.port) {
      moved = now;
      break;
    }
    await sleep(1000);
  }
  check(!!moved, "a proxy that stops moves to the next one that works", await status());
  check(moved && !moved.failing, "and it says connected, in the plain colour", moved);
  const s2 = await setting();
  check(s2?.rules?.singleProxy?.port === second.port, "Chrome's setting follows", s2);
} finally {
  await close();
  await second.close().catch(() => {});
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
