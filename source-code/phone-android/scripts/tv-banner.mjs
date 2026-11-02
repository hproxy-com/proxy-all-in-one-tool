/* The TV launcher's banner, and the bigger one Google Play's TV listing asks for: the mark and
   the name on the solid brand blue, drawn by a headless Chrome with its own empty profile.

     node phone-android/scripts/tv-banner.mjs [folder for the store picture] */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, "..", "app", "src", "main", "res");
const FONT = pathToFileURL(join(RES, "font", "inter_extrabold.ttf")).href;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const page = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Inter; src: url("${FONT}"); }
html, body { margin: 0; width: 320px; height: 180px; overflow: hidden; background: #0158ff; }
body { display: flex; align-items: center; justify-content: center; gap: 14px; }
span { color: #fff; font: 800 46px/1 Inter; letter-spacing: -1px; }
</style>
<svg width="39" height="46" viewBox="0 0 22 26" fill="#fff">
<path d="M0 0C3.98547 0 7.21633 3.23086 7.21633 7.21633V26H0V0Z"/>
<rect x="14.2188" width="7.21633" height="26"/>
<path d="M7.2349 26H0V15.9714C0 12.4548 2.85076 9.60408 6.36735 9.60408H14.2204V0H21.4367V10.4531C21.4367 13.9696 18.586 16.8204 15.0694 16.8204H7.2349V26Z"/>
</svg><span>HProxy</span>`;

const work = mkdtempSync(join(tmpdir(), "hproxy-tv-banner-"));
const html = join(work, "banner.html");
writeFileSync(html, page);

function draw(file, scale) {
  mkdirSync(dirname(file), { recursive: true });
  const r = spawnSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${join(work, "profile")}`,
      `--force-device-scale-factor=${scale}`,
      "--window-size=320,180",
      "--virtual-time-budget=2000",
      `--screenshot=${file}`,
      pathToFileURL(html).href,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr.slice(0, 300));
  console.log(file);
}

draw(join(RES, "drawable-xhdpi", "tv_banner.png"), 1);
const store = process.argv[2];
if (store) draw(join(resolve(store), "tv-banner-1280x720.png"), 4);
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
