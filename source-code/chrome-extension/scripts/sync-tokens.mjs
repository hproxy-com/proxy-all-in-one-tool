/* ============================================================
   sync-tokens.mjs — generate the extension's design tokens FROM
   the website, instead of retyping them.

     node scripts/sync-tokens.mjs            write tokens.css
     node scripts/sync-tokens.mjs --check    fail if tokens.css is stale

   WHY THIS EXISTS
     popup.css used to declare its own copy of every token. Copies do
     not receive fixes. On 2026-07-31 the website retuned its three
     status colours for WCAG AA and the extension kept the old ones,
     so it shipped for two days at:

       --ok    #12a150   3.37:1 on white   (needs 4.5:1 as text)
       --warn  #e8973a   2.35:1 on white
       --bad   #e5484d   3.91:1 on white

     Those exact three values are the ones the site's own audit had
     already condemned. Nobody was careless: the value simply had to
     be retyped to be corrected, and retyping is not a mechanism.

     So the popup no longer owns any colour. It imports this file,
     this file is generated, and build.ps1 regenerates it, which means
     a zip physically cannot be built with stale tokens.

   SCOPE
     Light theme only, on purpose. The popup is always the site's white
     Electric theme regardless of the OS scheme (decided 2026-07-23), so
     the midnight / sapphire / sky blocks are deliberately not read.
   ============================================================ */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..");
const OUT = join(EXT, "tokens.css");

/* Where the website is. Since 2026-09-23 the extension lives in
   Hproxy-Software-Bundle-Core/chrome-extension, a sibling of the HProxy
   monorepo, so the website is normally next door; HPROXY_WEBSITE (a folder
   holding app/globals.css) overrides it, and the old home inside the monorepo
   is still understood. */
const CANDIDATES = [
  process.env.HPROXY_WEBSITE ? join(process.env.HPROXY_WEBSITE, "app", "globals.css") : null,
  join(EXT, "..", "..", "Hproxy", "hproxy-website", "app", "globals.css"),
  join(EXT, "..", "hproxy-website", "app", "globals.css"),
].filter(Boolean);
const SOURCE = CANDIDATES.find((p) => existsSync(p)) ?? CANDIDATES[0];
/* Written into tokens.css; the same on every machine, so moving folders
   never makes the file look stale. */
const STAMP = "hproxy-website/app/globals.css";

/* Tokens that also get an `--x-rgb: r, g, b` companion, so a stylesheet can
   write rgba(var(--digi-rgb), 0.07) instead of hand-typing "1, 88, 255".
   Every one of those hand-typed triples is a copy that can go stale the same
   way the status colours did. */
const NEEDS_RGB = ["digi", "digi-deep", "digi-night", "digi-light", "ink", "ok", "warn", "danger"];

/* Read the :root block only. Brace-counting rather than a regex, because a
   comment inside the block contains braces and a lazy match stops early. */
function rootBlock(css) {
  const start = css.indexOf(":root");
  if (start === -1) throw new Error(`no :root block in ${SOURCE}`);
  const open = css.indexOf("{", start);
  if (open === -1) throw new Error(`malformed :root block in ${SOURCE}`);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated :root block in ${SOURCE}`);
}

/* Strip comments BEFORE scanning for declarations. globals.css carries long
   explanatory comments that quote old hex values ("red-500 #ef4444 is 3.76:1"),
   and a scanner that reads those would import the very values the comment is
   warning about. */
function declarations(block) {
  const clean = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const m of clean.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out.push([m[1].trim(), m[2].trim().replace(/\s+/g, " ")]);
  }
  if (!out.length) throw new Error(`parsed 0 tokens from ${SOURCE} — the format changed`);
  return out;
}

function hexToRgb(hex) {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(", ");
}

function render(tokens) {
  const stamp = STAMP;
  const lines = [
    "/* ============================================================",
    "   GENERATED FILE — DO NOT EDIT BY HAND.",
    "",
    `   Source:    ${stamp}`,
    "   Regenerate: node scripts/sync-tokens.mjs   (build.ps1 runs this)",
    "",
    "   Every colour the popup is allowed to use lives here, copied",
    "   from the website's :root at build time. Editing this file by",
    "   hand recreates exactly the drift it exists to prevent: the",
    "   next build silently overwrites you.",
    "",
    "   Need a new colour? Add it to the website's globals.css. That",
    "   is the only door, and it is deliberately the only door.",
    "   ============================================================ */",
    ":root {",
    "  /* The popup is light only and never follows the OS scheme. This lock",
    "     stops a dark-OS browser from dark-ifying inputs and scrollbars. */",
    "  color-scheme: light;",
    "",
  ];

  for (const [name, value] of tokens) {
    lines.push(`  ${name}: ${value};`);
    const bare = name.slice(2);
    if (NEEDS_RGB.includes(bare)) {
      const rgb = hexToRgb(value);
      if (rgb) lines.push(`  ${name}-rgb: ${rgb};`);
    }
  }

  lines.push(
    "",
    "  /* Extension-only shapes. Not colours, so they are not drift risks:",
    "     they map to the site's rounded-2xl / rounded-xl / rounded-lg. */",
    "  --radius: 16px;",
    "  --radius-sm: 12px;",
    "  --radius-xs: 8px;",
    "",
    "  /* The site's blue-tinted elevation. Shadows are never grey on this",
    "     brand, they are always tinted with digi-night. */",
    "  --shadow: 0 2px 4px rgba(var(--digi-night-rgb), 0.04),",
    "    0 22px 48px -28px rgba(var(--digi-night-rgb), 0.42);",
    "}",
    "",
  );
  return lines.join("\n");
}

/* ---------------------------------------------------------------- */

/* Without the website (the bundle cloned on its own), the committed
   tokens.css is the last synced copy of the website's palette: keep it and
   say so, rather than stop every build. On a machine that has the website,
   a stale copy still fails the check below. */
if (!existsSync(SOURCE)) {
  console.log(`sync-tokens: the website is not here (looked in ${CANDIDATES.join(", ")}).`);
  console.log("sync-tokens: keeping tokens.css as committed. Set HPROXY_WEBSITE to sync it.");
  process.exit(0);
}

const tokens = declarations(rootBlock(readFileSync(SOURCE, "utf8")));
const next = render(tokens);
const check = process.argv.includes("--check");
const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;

if (check) {
  if (current !== next) {
    console.error("sync-tokens: tokens.css is STALE. Run: node scripts/sync-tokens.mjs");
    process.exit(1);
  }
  console.log(`sync-tokens: tokens.css is current (${tokens.length} tokens).`);
} else if (current === next) {
  console.log(`sync-tokens: tokens.css already current (${tokens.length} tokens).`);
} else {
  writeFileSync(OUT, next, "utf8");
  console.log(`sync-tokens: wrote tokens.css from ${tokens.length} website tokens.`);
}
