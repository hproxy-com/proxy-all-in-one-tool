/* ============================================================
   popup-look.mjs: the popup's page, in a real browser (1.0.6).

     node tests/e2e/popup-look.mjs

   The top is the full width of the popup and stays while the list scrolls;
   the map is drawn; Settings is a page that keeps the window's height; the
   look is dark until white is chosen, and a choice survives the next opening.
   Chrome for Testing, never the browser in use (cdp.mjs).
   ============================================================ */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey, launchWithExtension, navigate, newPage } from "./cdp.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ID = extensionIdFromKey(JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")).key);
const POPUP = `chrome-extension://${ID}/popup.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(ok, what, seen) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) {
    failed++;
    console.log("      seen:", JSON.stringify(seen));
  }
}

const MANY = Array.from({ length: 40 }, (_, i) => ({
  host: `198.51.100.${i + 1}`,
  port: 8080,
  scheme: "http",
  username: "",
  password: "",
  country: "NL",
}));

const { cdp, close } = await launchWithExtension({ extensionDir: EXT, headless: true, extraArgs: ["--lang=en-US"] });
try {
  const { sessionId: s } = await newPage(cdp, { width: 384, height: 600 });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 384, height: 600, deviceScaleFactor: 1, mobile: false }, s);
  const js = (e) => cdp.evaluate(s, e);
  const canvas = () => js(`getComputedStyle(document.body).backgroundColor`);
  const opened = async () => {
    await navigate(cdp, s, POPUP);
    await sleep(900);
  };

  await opened();
  await js(`chrome.storage.local.set({ hproxy_byo: ${JSON.stringify(MANY)} }).then(() => true)`);
  await opened();

  // The look.
  check((await js(`document.documentElement.dataset.theme`)) === "midnight", "dark unless chosen otherwise", null);
  check((await canvas()) === "rgb(12, 12, 15)", "the computer app's dark", await canvas());
  check(await js(`document.getElementById("darkOn").checked`), "and Settings says so", null);

  // The map.
  const land = await js(`document.getElementById("mapLand").getAttribute("d").length`);
  check(land > 5000, "the map is drawn", land);
  check((await js(`document.querySelectorAll(".map use").length`)) === 6, "under the flood and on it", null);
  check((await js(`document.getElementById("mapLit").getAttribute("d").length`)) > 0, "the next proxy's country is lit", null);

  // Red is red all the way: the fill, the switch and the words, in solid colours.
  const redLook = await js(`(() => {
    const conn = document.getElementById("conn");
    conn.dataset.phase = "on";
    conn.toggleAttribute("data-failing", true);
    document.getElementById("now").hidden = false;
    return new Promise((done) => setTimeout(() => {
      const of = (node, what) => getComputedStyle(node)[what];
      done({
        flood: of(document.querySelector(".hero-flood"), "backgroundColor"),
        track: of(document.getElementById("connSwitch"), "backgroundColor"),
        knob: of(document.querySelector(".knob"), "color"),
        words: of(document.getElementById("subWords"), "color"),
      });
    }, 1400));
  })()`);
  check(redLook.flood === "rgb(198, 40, 40)", "a proxy that stopped turns the top solid red", redLook);
  check(redLook.track === "rgb(158, 31, 31)" && redLook.knob === "rgb(198, 40, 40)", "the switch with it", redLook);
  check(redLook.words === "rgb(255, 227, 227)", "and the words", redLook);
  await js(`(() => { const conn = document.getElementById("conn"); conn.dataset.phase = "off"; conn.removeAttribute("data-failing"); document.getElementById("now").hidden = true; return true; })()`);

  // The top stays, and it is the popup's full width.
  check((await js(`document.getElementById("conn").getBoundingClientRect().width`)) === 384, "the top is as wide as the popup", null);
  const before = await js(`document.getElementById("connSwitch").getBoundingClientRect().top`);
  const list = await js(`(() => { const b = document.getElementById("scroller"); b.scrollTo(0, 1e6); return { top: b.scrollTop, room: b.clientHeight, all: b.scrollHeight }; })()`);
  await sleep(100);
  check(list.top > 500, "the list scrolls by itself", list);
  check((await js(`document.getElementById("connSwitch").getBoundingClientRect().top`)) === before, "and the switch stays in view", null);
  check((await js(`document.documentElement.scrollHeight <= 600`)), "the page itself is not taller than Chrome's popup", null);
  check((await js(`document.querySelector(".tabs-band").getBoundingClientRect().top === document.getElementById("scroller").getBoundingClientRect().top`)), "the tabs stay over the list", null);

  // Settings.
  const tall = await js(`document.getElementById("main").offsetHeight`);
  await js(`document.getElementById("settingsBtn").click(); true`);
  await sleep(100);
  check((await js(`document.getElementById("main").hidden && !document.getElementById("sheet").hidden`)), "the gear opens Settings", null);
  check((await js(`document.getElementById("sheet").offsetHeight`)) === tall, "the window keeps its height", null);
  check((await js(`document.getElementById("footNote").textContent`)).startsWith("Version "), "with the version", null);
  await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  await sleep(100);
  check((await js(`!document.getElementById("main").hidden && document.getElementById("sheet").hidden`)), "Esc comes back", null);

  // White, chosen, and kept.
  await js(`document.getElementById("settingsBtn").click(); document.getElementById("darkOn").click(); true`);
  await sleep(400);
  check((await js(`document.documentElement.dataset.theme`)) === undefined, "white at once", null);
  await opened();
  check((await js(`document.documentElement.dataset.theme`)) === undefined, "and at the next opening", null);
  check((await canvas()) === "rgb(255, 255, 255)", "the white look", await canvas());
  check(!(await js(`document.getElementById("darkOn").checked`)), "and Settings says so", null);
  await js(`document.getElementById("settingsBtn").click(); document.getElementById("darkOn").click(); true`);
  await opened();
  check((await js(`document.documentElement.dataset.theme`)) === "midnight", "dark again", null);
} finally {
  await close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nevery check passed");
process.exit(failed ? 1 : 0);
