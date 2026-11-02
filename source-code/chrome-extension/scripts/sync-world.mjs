/* ============================================================
   sync-world.mjs: the dot map of the popup's top, FROM the computer app.

     node scripts/sync-world.mjs            write world.js
     node scripts/sync-world.mjs --check    fail if world.js is stale

   The app keeps the world as dots in
   desktop-app/src/components/connect/worldDots.ts (Natural Earth, public
   domain; a cell is 3 degrees square). This writes the same data as plain
   JavaScript without its types, so there is one world, the way tokens.css
   makes one palette (sync-tokens.mjs). build.ps1 runs it.
   ============================================================ */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..");
const OUT = join(EXT, "world.js");
const SOURCE = join(EXT, "..", "desktop-app", "src", "components", "connect", "worldDots.ts");

/* The bundle's other folders are always beside this one, but a zip of the
   extension alone can still build from the committed copy. */
if (!existsSync(SOURCE)) {
  console.log(`sync-world: ${SOURCE} is not here, keeping world.js as committed.`);
  process.exit(0);
}

const body = readFileSync(SOURCE, "utf8")
  // The file's own header goes: this one says where the data comes from.
  .replace(/^\/\*[\s\S]*?\*\/\s*/, "")
  .replace(/\s+as const\b/g, "")
  .replace(/:\s*Readonly<[^=]*>\s*=/g, " =")
  .replace(/\r\n/g, "\n");

const next = `/* GENERATED FILE, DO NOT EDIT BY HAND.
   Source: desktop-app/src/components/connect/worldDots.ts (Natural Earth 1:50m,
   public domain). Regenerate: node scripts/sync-world.mjs (build.ps1 runs it).

   A cell is 3 degrees square; cell number = row * 120 + column, written in
   base 36. Row 0 starts at 84 degrees north, column 0 at -180 degrees. */

${body}`;

const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
if (process.argv.includes("--check")) {
  if (current !== next) {
    console.error("sync-world: world.js is STALE. Run: node scripts/sync-world.mjs");
    process.exit(1);
  }
  console.log("sync-world: world.js is current.");
} else if (current === next) {
  console.log("sync-world: world.js already current.");
} else {
  writeFileSync(OUT, next, "utf8");
  console.log("sync-world: wrote world.js.");
}
