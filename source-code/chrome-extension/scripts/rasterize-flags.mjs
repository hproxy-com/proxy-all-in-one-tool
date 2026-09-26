/* ============================================================
   rasterize-flags.mjs — the flags the popup ships, as small PNGs.

     node scripts/rasterize-flags.mjs          write flags/*.png from flags/*.svg
     node scripts/rasterize-flags.mjs --check  fail if a PNG is missing or older

   WHY
     The flags are flag-icons' 4:3 SVGs (MIT, flags/LICENSE). 182 of the
     271 are under 2 KB, but the coats of arms are not: Serbia alone is
     181 KB, and all of them together were 2.0 MB, 90% of the extension.
     The popup draws 119 of them at 22 x 16 pixels every time the VPN tab
     opens, and Chrome draws SVG images on the main thread. Measured
     2026-09-23: the tab took about 1 s to show its flags.

     A PNG at three times the drawn size (66 x 48 for 22 x 16) is sharp on
     every common screen, decodes off the main thread, and weighs a few
     hundred bytes.

     The SVGs stay in the repository as the source and are not shipped
     (build.ps1 takes flags/*.png and the licence only).

   Needs Chrome for Testing (the same one tests/e2e uses).
   ============================================================ */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchWithExtension, newPage } from "../tests/e2e/cdp.mjs";

const FLAGS = join(dirname(fileURLToPath(import.meta.url)), "..", "flags");
const WIDTH = 66;
const HEIGHT = 48;

const svgs = readdirSync(FLAGS).filter((f) => f.endsWith(".svg")).sort();
const pngOf = (svg) => join(FLAGS, svg.replace(/\.svg$/, ".png"));
const stale = svgs.filter((f) => !existsSync(pngOf(f)) || statSync(pngOf(f)).mtimeMs < statSync(join(FLAGS, f)).mtimeMs);

if (process.argv.includes("--check")) {
  if (stale.length) {
    console.error(`rasterize-flags: ${stale.length} PNG(s) missing or older than their SVG (${stale.slice(0, 5).join(", ")}). Run: node scripts/rasterize-flags.mjs`);
    process.exit(1);
  }
  console.log(`rasterize-flags: all ${svgs.length} PNGs are current.`);
  process.exit(0);
}

const { cdp, close } = await launchWithExtension({ extensionDir: null, headless: true });
try {
  const page = await newPage(cdp, { width: 200, height: 200 });
  let bytesIn = 0;
  let bytesOut = 0;
  for (const file of svgs) {
    const svg = readFileSync(join(FLAGS, file));
    bytesIn += svg.length;
    // Drawn into a canvas the size of the PNG. The flags are 4:3 and so is
    // 64 x 48; 66 x 48 matches the popup's 22 x 16 box, which crops the same
    // two pixels the browser crops with object-fit: cover today.
    const dataUrl = await cdp.evaluate(
      page.sessionId,
      `new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = ${WIDTH}; c.height = ${HEIGHT};
          const ctx = c.getContext("2d");
          ctx.imageSmoothingQuality = "high";
          const scale = Math.max(${WIDTH} / img.naturalWidth, ${HEIGHT} / img.naturalHeight);
          const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
          ctx.drawImage(img, (${WIDTH} - w) / 2, (${HEIGHT} - h) / 2, w, h);
          resolve(c.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("could not draw ${file}"));
        img.src = "data:image/svg+xml;base64,${svg.toString("base64")}";
      })`,
    );
    const png = Buffer.from(dataUrl.split(",")[1], "base64");
    bytesOut += png.length;
    writeFileSync(pngOf(file), png);
  }
  console.log(`rasterize-flags: ${svgs.length} flags, ${(bytesIn / 1e6).toFixed(2)} MB of SVG -> ${(bytesOut / 1e3).toFixed(0)} KB of PNG at ${WIDTH}x${HEIGHT}.`);
} finally {
  await close();
}
