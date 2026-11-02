/* ============================================================
   A PROXY THAT STOPS, AND THE KILL SWITCH.

     node tests/e2e/kill-switch.mjs

   The extension in Chrome for Testing (a throwaway profile, never anyone's
   Chrome), connected through a test proxy on this machine. The proxy is taken
   away and brought back, and the run reads the popup, the worker's status and
   Chrome's own proxy setting:
     1. kill switch on (the default): the popup turns to Stopped working and
        says pages wait; Chrome stays on the proxy, so nothing leaves on the
        person's own address;
     2. the proxy comes back: Connected again, by itself;
     3. kill switch off: the proxy stops, Chrome's setting goes away, and it
        says so;
     4. the proxy comes back: the setting returns, by itself;
     5. disconnect leaves nothing behind.

   The alarm that asks a stopped proxy again runs every half a minute, so a run
   takes a few minutes. Exit code 0 when every check passed, 1 otherwise.
   ============================================================ */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey, launchWithExtension, navigate, newPage } from "./cdp.mjs";
import { startTestProxy } from "./test-proxy.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const POPUP = `chrome-extension://${extensionIdFromKey(manifest.key)}/${manifest.action?.default_popup || "popup.html"}`;
const PAGE = "https://example.com/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (ok, what, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

const { cdp, close } = await launchWithExtension({ extensionDir: EXT, headless: true });
let proxy = await startTestProxy();
const port = proxy.port;
try {
  const popup = await newPage(cdp, { width: 380, height: 640 });
  const browse = await newPage(cdp, { width: 800, height: 600 });
  const js = (e) => cdp.evaluate(popup.sessionId, e);
  const ask = (message) => js(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  const status = async () => (await ask({ type: "status" }))?.active ?? null;
  /* Cleared, Chrome goes back to its own default, "system": the setting of this computer. */
  const setting = () => js(`new Promise((r) => chrome.proxy.settings.get({}, (d) => r(d.value?.mode ?? "system")))`);
  const words = () => js(`document.getElementById("statusTitle")?.textContent ?? ""`);
  const sub = () => js(`document.getElementById("statusSub")?.textContent ?? ""`);
  const red = () => js(`document.getElementById("conn").hasAttribute("data-failing")`);
  /* A page through whatever is in effect now: what makes the worker look. */
  const tryPage = () => navigate(cdp, browse.sessionId, `${PAGE}?${Date.now()}`, 8000).catch(() => {});
  const until = async (test, ms) => {
    const from = Date.now();
    for (;;) {
      if (await test()) return true;
      if (Date.now() - from > ms) return false;
      await sleep(1000);
    }
  };
  const stops = async () => {
    await proxy.close();
    return until(async () => {
      await tryPage();
      return (await status())?.failing === true;
    }, 40000);
  };
  const comesBack = async (test) => {
    proxy = await startTestProxy({ port });
    return until(test, 90000);
  };

  await navigate(cdp, popup.sessionId, POPUP);
  await sleep(800);
  check(await js(`document.getElementById("killOn").checked`), "the kill switch is on by default", null);

  const found = await ask({ type: "pinFind", proxy: { host: "127.0.0.1", port, username: "", password: "" }, schemes: ["http"] });
  check(!!found?.found?.exitIp, "the test proxy answers", found);
  await ask({
    type: "pinConnect",
    proxy: { host: "127.0.0.1", port, username: "", password: "", scheme: "http" },
    verified: true,
    exitIp: found?.found?.exitIp,
    country: found?.found?.country,
    label: "test proxy",
  });
  await sleep(800);
  check((await status())?.failing === false, "connected", await status());

  // 1. It stops, kill switch on.
  check(await stops(), "the worker notices a proxy that stopped", await status());
  await navigate(cdp, popup.sessionId, POPUP);
  await sleep(1500);
  check(await red(), "the popup turns red", await words());
  check((await words()) === "Connection refused", "and says what went wrong, by its name", await words());
  check(/Kill switch on/.test(await sub()), "and what that means", await sub());
  check((await setting()) === "fixed_servers", "Chrome stays on the proxy: nothing leaves on the own address", await setting());

  // 2. It comes back.
  check(await comesBack(async () => (await status())?.failing === false), "it comes back by itself", await status());
  await navigate(cdp, popup.sessionId, POPUP);
  await sleep(1500);
  check(!(await red()), "the red goes", await words());

  // 3. It stops, kill switch off.
  await js(`document.getElementById("settingsBtn").click(); document.getElementById("killOn").click(); true`);
  await sleep(800);
  check((await js(`document.getElementById("killOn").checked`)) === false, "switched off", null);
  check(await stops(), "the worker notices again", await status());
  await sleep(500);
  check((await status())?.ownAddress === true, "pages are on the own address", await status());
  check((await setting()) === "system", "Chrome's setting went away", await setting());
  await navigate(cdp, popup.sessionId, POPUP);
  await sleep(1500);
  check(/own address/.test(await sub()), "and the popup says so", await sub());

  // 4. It comes back.
  check(
    await comesBack(async () => (await setting()) === "fixed_servers" && (await status())?.failing === false),
    "the setting returns by itself",
    await setting(),
  );

  // 5. Off.
  await ask({ type: "disconnect" });
  await sleep(500);
  check((await status()) === null && (await setting()) === "system", "disconnect leaves nothing behind", await setting());
} finally {
  await proxy.close().catch(() => {});
  await close();
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
