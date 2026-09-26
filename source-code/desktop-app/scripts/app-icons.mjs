// app-icons.mjs: every icon the HProxy app needs, on every system and store, from the brand's
// vector H. Run from desktop-app/:  node scripts/app-icons.mjs
//
// The icon is the logo itself: the blue H (hproxy-website/public/brand-kit/mark-blue.svg, its
// gradient #3D7BFF, #0158FF, #013599 across the H), with no tile around it: a blue H, not a
// white one, and no button behind it.
// Where a system allows any shape, the icon is the H alone; where a system always draws a tile
// (iPhone, Android, macOS 26) or a store forbids transparency (Google Play, the App Store), the
// tile is white and the H stays blue. (Before 2026-09-24 the app shipped a plain block H that is
// not the brand's mark, and the Android app shipped Tauri's own logo.)
//
// One master per system (icons/source/):
//   desktop.svg     Windows (.ico), Linux (PNGs), the Windows Store tiles: the H alone on
//                   transparency, 86 % of the height
//   macos.svg       macOS up to 15 (icon.icns): the H alone, 78 % of the height (the optical
//                   size of the Mac's 824 px bodies), with a soft shadow like the Mac's icons
//   ios.svg         iPhone, iPad, the App Store, Google Play: a full white square, no rounded
//                   corners (the system rounds it), no transparency (Apple refuses an alpha
//                   channel, Google forbids a transparent background); the H 56 % of the height
//   android-*.svg   Android's adaptive icon: white behind, the H in front inside the safe circle
//                   (56 % of what a launcher shows), and a monochrome H for themed icons
// macOS 26 and later draws only an asset-catalog icon; a bundle with just icon.icns gets its
// icon on a grey tile. icons/macos/AppIcon.icon is the Icon Composer package for it: the
// system's own light tile (its dark tile in dark mode) with the blue H as a glass layer. Xcode's
// actool compiles it to Assets.car on the macOS runner (release.yml), and
// tauri.macos.conf.json + Info.plist put it in the app.
//
// Store listings (store/): Microsoft Store logo 300 x 300 (the H alone), Google Play icon
// 512 x 512 and App Store icon 1024 x 1024 (the white square, no alpha). The Play feature
// graphic (1024 x 500) is drawn on hproxy.com's design page /design/app-icons and saved there.
//
// The Chrome extension (../chrome-extension/icons/): icon16, icon48 and icon128, from desktop.svg,
// the H alone on transparency. The manifest uses them for the toolbar button, the extensions page
// and the Chrome Web Store listing. (Until 2026-09-25 the extension still carried the white H on
// a blue tile from July, which the store listing showed.)
//
// `tauri icon` (tauri-cli, already the app's build tool) draws the SVGs. Nothing is typed by
// hand: rerun this after any change to the mark, and the checks at the end say where the H
// landed in every file.

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boundingBox, decodePng, encodePng, flatten } from "./png.mjs";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = join(APP, "src-tauri", "icons");
const SOURCE = join(ICONS, "source");
const PACKAGE = join(ICONS, "macos", "AppIcon.icon");
const ANDROID_RES = join(APP, "src-tauri", "gen", "android", "app", "src", "main", "res");
const STORE = join(APP, "store");
const EXTENSION_ICONS = join(APP, "..", "chrome-extension", "icons");
const WHITE = "#FFFFFF";

/* ---------- the masters ---------- */

/* The brand's H, a 22 x 26 box, and the logo's gradient across that box (mark-blue.svg). */
const H_PATHS =
  `<path d="M0 0V0C3.98547 0 7.21633 3.23086 7.21633 7.21633V26H0V0Z"/>` +
  `<rect x="14.2188" width="7.21633" height="26"/>` +
  `<path d="M7.2349 26H0V15.9714C0 12.4548 2.85076 9.60408 6.36735 9.60408H14.2204V0H21.4367V10.4531C21.4367 13.9696 18.586 16.8204 15.0694 16.8204H7.2349V26Z"/>`;
const H_GRADIENT =
  `<linearGradient id="h" x1="0" y1="0" x2="22" y2="26" gradientUnits="userSpaceOnUse">` +
  `<stop offset="0" stop-color="#3D7BFF"/><stop offset="0.5" stop-color="#0158FF"/><stop offset="1" stop-color="#013599"/></linearGradient>`;

/** The H centred on the 1024 canvas, `share` of its height, in the logo's blue (or `fill`). */
function placeH(share, { fill = "url(#h)", filter = "" } = {}) {
  const s = (1024 * share) / 26;
  const x = (512 - 11 * s).toFixed(2);
  const y = (512 - 13 * s).toFixed(2);
  return `<g transform="translate(${x} ${y}) scale(${s.toFixed(5)})" fill="${fill}"${filter ? ` filter="${filter}"` : ""}>${H_PATHS}</g>`;
}

const svg = (body, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>\n`;
const WHITE_SQUARE = `<rect width="1024" height="1024" fill="${WHITE}"/>`;

/* The H's height per master, as a share of the canvas. */
const SHARE = { desktop: 0.86, macos: 0.78, tile: 0.56, androidLayer: 0.37 };

const MASTERS = {
  "desktop.svg": svg(placeH(SHARE.desktop), H_GRADIENT),
  "macos.svg": svg(
    placeH(SHARE.macos, { filter: "url(#shadow)" }),
    H_GRADIENT + `<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="0.45" stdDeviation="0.45" flood-color="#012a80" flood-opacity="0.35"/></filter>`,
  ),
  "ios.svg": svg(WHITE_SQUARE + placeH(SHARE.tile), H_GRADIENT),
  "android-background.svg": svg(WHITE_SQUARE),
  "android-foreground.svg": svg(placeH(SHARE.androidLayer), H_GRADIENT),
  "android-monochrome.svg": svg(placeH(SHARE.androidLayer, { fill: "#ffffff" })),
  /* The layer of the macOS 26 package: the H alone on the full canvas; the Mac draws the tile. */
  "macos26-h.svg": svg(placeH(SHARE.tile), H_GRADIENT),
};

/* tauri icon's manifest. android_fg_scale sizes the H on the pre-adaptive launcher icons only
   (Android 7); 62 puts it near the adaptive icon's share, measured (the adaptive layer keeps the
   SVG's own geometry). bg_color is the white the iOS icons are flattened onto. */
const MANIFEST = {
  default: "desktop.svg",
  bg_color: WHITE,
  android_bg: "android-background.svg",
  android_fg: "android-foreground.svg",
  android_monochrome: "android-monochrome.svg",
  android_fg_scale: 62,
};

/* ---------- running tauri icon ---------- */

function tauriIcon(input, out, extra = []) {
  execFileSync("npx", ["tauri", "icon", input, "-o", out, ...extra], { cwd: APP, stdio: ["ignore", "ignore", "pipe"], shell: true });
}

function copyInto(from, to, names) {
  mkdirSync(to, { recursive: true });
  for (const name of names) copyFileSync(join(from, name), join(to, name));
}

/** A PNG file without its alpha channel, on white (Apple's rule for app icons). */
function withoutAlpha(file) {
  writeFileSync(file, encodePng(flatten(decodePng(readFileSync(file)), WHITE)));
}

// This script owns the masters and the macOS package: start them clean, so nothing stale stays.
rmSync(SOURCE, { recursive: true, force: true });
rmSync(PACKAGE, { recursive: true, force: true });
mkdirSync(SOURCE, { recursive: true });
for (const [name, text] of Object.entries(MASTERS)) writeFileSync(join(SOURCE, name), text);
writeFileSync(join(SOURCE, "manifest.json"), `${JSON.stringify(MANIFEST, null, 2)}\n`);

const work = mkdtempSync(join(tmpdir(), "hproxy-icons-"));
try {
  // Windows, Linux, the Windows Store tiles, Android.
  tauriIcon(join(SOURCE, "manifest.json"), join(work, "main"));
  const desktop = readdirSync(join(work, "main")).filter((f) => f.endsWith(".png") || f === "icon.ico");
  copyInto(join(work, "main"), ICONS, desktop);
  rmSync(join(ICONS, "android"), { recursive: true, force: true });
  cpSync(join(work, "main", "android"), join(ICONS, "android"), { recursive: true });
  if (existsSync(ANDROID_RES)) cpSync(join(work, "main", "android"), ANDROID_RES, { recursive: true });

  // macOS up to 15.
  tauriIcon(join(SOURCE, "macos.svg"), join(work, "mac"));
  copyFileSync(join(work, "mac", "icon.icns"), join(ICONS, "icon.icns"));

  // iPhone and iPad: the white square, no alpha channel.
  tauriIcon(join(SOURCE, "ios.svg"), join(work, "ios"), ["--ios-color", WHITE]);
  rmSync(join(ICONS, "ios"), { recursive: true, force: true });
  cpSync(join(work, "ios", "ios"), join(ICONS, "ios"), { recursive: true });
  for (const f of readdirSync(join(ICONS, "ios"))) withoutAlpha(join(ICONS, "ios", f));

  // macOS 26: the Icon Composer package. The system draws the tile (light, or dark in dark mode).
  mkdirSync(join(PACKAGE, "Assets"), { recursive: true });
  tauriIcon(join(SOURCE, "macos26-h.svg"), join(work, "h"), ["--png", "1024"]);
  copyFileSync(join(work, "h", "1024x1024.png"), join(PACKAGE, "Assets", "h.png"));
  writeFileSync(
    join(PACKAGE, "icon.json"),
    `${JSON.stringify(
      {
        "fill-specializations": [{ value: "system-light" }, { appearance: "dark", value: "system-dark" }],
        groups: [
          {
            layers: [{ glass: true, "image-name": "h.png", name: "H" }],
            lighting: "individual",
            shadow: { kind: "neutral", opacity: 0.5 },
            translucency: { enabled: false, value: 0.5 },
          },
        ],
        "supported-platforms": { squares: "shared" },
      },
      null,
      2,
    )}\n`,
  );

  // Store listings.
  tauriIcon(join(SOURCE, "desktop.svg"), join(work, "ms"), ["--png", "300"]);
  copyInto(join(work, "ms"), join(STORE, "microsoft-store"), ["300x300.png"]);
  tauriIcon(join(SOURCE, "ios.svg"), join(work, "play"), ["--png", "512"]);
  copyInto(join(work, "play"), join(STORE, "google-play"), ["512x512.png"]);
  withoutAlpha(join(STORE, "google-play", "512x512.png"));
  mkdirSync(join(STORE, "app-store"), { recursive: true });
  copyFileSync(join(ICONS, "ios", "AppIcon-512@2x.png"), join(STORE, "app-store", "icon-1024.png"));

  // The Chrome extension: the toolbar button, the extensions page and the Web Store listing.
  for (const size of [16, 48, 128]) {
    tauriIcon(join(SOURCE, "desktop.svg"), join(work, `extension-${size}`), ["--png", String(size)]);
    copyFileSync(join(work, `extension-${size}`, `${size}x${size}.png`), join(EXTENSION_ICONS, `icon${size}.png`));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

/* ---------- the checks: where the H landed, and what Apple and Google require ---------- */

/* The H's pixels: the logo's blue, whatever is behind it (edges blended with white are left out). */
const blueH = (r, g, b, a) => a > 128 && b > 140 && r < 110 && g < 150;
const CHECKS = [
  // file, the H's height as a share of the image, alpha allowed
  ["src-tauri/icons/icon.png", SHARE.desktop, true],
  ["src-tauri/icons/128x128.png", SHARE.desktop, true],
  ["src-tauri/icons/32x32.png", SHARE.desktop, true],
  ["src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher_foreground.png", SHARE.androidLayer, true],
  ["src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher.png", 0.52, true],
  ["src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher_round.png", 0.57, true],
  ["src-tauri/icons/ios/AppIcon-512@2x.png", SHARE.tile, false],
  ["src-tauri/icons/ios/AppIcon-20x20@1x.png", SHARE.tile, false],
  ["src-tauri/icons/macos/AppIcon.icon/Assets/h.png", SHARE.tile, true],
  ["store/microsoft-store/300x300.png", SHARE.desktop, true],
  ["store/google-play/512x512.png", SHARE.tile, false],
  ["store/app-store/icon-1024.png", SHARE.tile, false],
  ["../chrome-extension/icons/icon128.png", SHARE.desktop, true],
  ["../chrome-extension/icons/icon48.png", SHARE.desktop, true],
  ["../chrome-extension/icons/icon16.png", SHARE.desktop, true],
];
let failed = 0;
function check(label, image, share, alphaAllowed) {
  const box = boundingBox(image, blueH);
  const height = box ? box.bottom - box.top : 0;
  const centred = box ? Math.abs((box.top + box.bottom) / 2 - 0.5) < 0.03 : false;
  // Small files have whole-pixel edges: more slack at 20 and 32 px.
  const near = Math.abs(height - share) <= (image.width <= 40 ? 0.12 : 0.03);
  const alphaOk = alphaAllowed || image.channels === 3;
  const ok = near && centred && alphaOk;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(66)} ${image.width}x${image.height} ${image.channels === 3 ? "RGB " : "RGBA"} H ${(height * 100).toFixed(1)}% (want ${(share * 100).toFixed(1)}%)${alphaOk ? "" : "  has an alpha channel"}`);
}
for (const [file, share, alphaAllowed] of CHECKS) check(file, decodePng(readFileSync(join(APP, file))), share, alphaAllowed);

/* icon.icns holds one PNG per size; its 1024 image (type ic10) is the macOS master. */
function icnsEntries(file) {
  const out = new Map();
  for (let at = 8; at + 8 <= file.length; ) {
    const type = file.toString("latin1", at, at + 4);
    const length = file.readUInt32BE(at + 4);
    out.set(type, file.subarray(at + 8, at + length));
    at += length;
  }
  return out;
}
const icns = icnsEntries(readFileSync(join(ICONS, "icon.icns")));
if (icns.get("ic10")) check(`src-tauri/icons/icon.icns (1024, of ${icns.size} sizes)`, decodePng(icns.get("ic10")), SHARE.macos, true);
else {
  failed++;
  console.log("FAIL src-tauri/icons/icon.icns has no 1024 image");
}

/* icon.ico: the sizes Windows asks for, from the taskbar to Explorer's large view. */
const ico = readFileSync(join(ICONS, "icon.ico"));
const icoSizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256).sort((a, b) => a - b);
const icoOk = [16, 24, 32, 48, 64, 256].every((s) => icoSizes.includes(s));
if (!icoOk) failed++;
console.log(`${icoOk ? "ok  " : "FAIL"} src-tauri/icons/icon.ico sizes ${icoSizes.join(", ")}`);

if (failed) {
  console.error(`${failed} icon(s) are not where they should be`);
  process.exit(1);
}
