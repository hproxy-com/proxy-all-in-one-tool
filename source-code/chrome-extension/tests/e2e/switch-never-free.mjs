/* ============================================================
   THE POWER BUTTON NEVER TAKES A FREE PROXY BY ITSELF.

     node tests/e2e/switch-never-free.mjs

   The popup in Chrome for Testing (a throwaway profile, never anyone's
   Chrome), its storage set up as a person's would be:
     1. nothing saved: the button connects nothing, the popup opens "My
        proxies" and says "Add your proxies first to start connecting!";
     2. a saved proxy, connected last before a free country: the line under
        the button names the saved one, never the country.
   No connection is made: every check reads the popup and the worker's
   status, nothing goes through a proxy.

   Exit code 0 when every check passed, 1 otherwise.
   ============================================================ */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey, launchWithExtension, navigate, newPage } from "./cdp.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const POPUP = `chrome-extension://${extensionIdFromKey(manifest.key)}/${manifest.action?.default_popup || "popup.html"}`;
const ADD_FIRST = "Add your proxies first to start connecting!";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const open = async (storage) => {
    await navigate(cdp, s, POPUP);
    await js(`chrome.storage.local.clear().then(() => chrome.storage.local.set(${JSON.stringify(storage)}))`);
    await navigate(cdp, s, POPUP);
    await sleep(1500);
  };

  // 1. Nothing saved.
  await open({});
  check((await js(`document.getElementById("heroHint").textContent`)) === ADD_FIRST, "with nothing saved, the line under the button says yours come first", await js(`document.getElementById("heroHint").textContent`));
  await js(`document.querySelector('[data-surface="vpn"]').click(); true`);
  await sleep(400);
  await js(`document.getElementById("connSwitch").click(); true`);
  await sleep(1500);
  const after = JSON.parse(
    await js(`JSON.stringify({
      msg: document.getElementById("byoMsg").hidden ? null : document.getElementById("byoMsg").textContent,
      proxiesShown: !document.getElementById("surface-proxies").hidden,
      focused: document.activeElement?.id || null,
      on: document.getElementById("connSwitch").getAttribute("aria-checked"),
    })`),
  );
  check(after.msg === ADD_FIRST, "a press says to add yours first", after.msg);
  check(after.proxiesShown, "and opens My proxies, even from the Free tab", after);
  check(after.focused === "byoInput", "with the paste box ready", after.focused);
  check(after.on === "false", "and connects nothing", after.on);
  const status = await js(`chrome.runtime.sendMessage({ type: "status" }).then((r) => JSON.stringify({ active: !!r?.active, searching: !!r?.searching }))`);
  check(status === JSON.stringify({ active: false, searching: false }), "the worker is not looking for a free exit either", status);

  // 2. A saved proxy, used before a free country.
  const saved = { host: "198.51.100.7", port: 8080, label: "198.51.100.7:8080", name: "Shop account" };
  await open({
    hproxy_byo: [saved],
    hproxy_last_target: { kind: "vpn", country: "DE" },
    hproxy_last_own: { kind: "pin", key: "198.51.100.7:8080" },
  });
  const hint = await js(`document.getElementById("heroHint").textContent`);
  check(hint === "Connects to Shop account", "after a free country, the button still goes to your own", hint);
  const title = await js(`document.getElementById("connSwitch").title`);
  check(title === "Connect to Shop account", "its title says the same", title);
} finally {
  await close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nevery check passed");
process.exitCode = failed ? 1 : 0;
