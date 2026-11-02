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
     Two looks since 1.0.6 (until then white only, decided 2026-07-23): the
     white one is the website's :root, the dark one and the default is the
     computer app's Graphite, so the popup and the app are one product. The
     app's files are in this repository and are read the same way: its dark
     blocks in desktop-app/src/styles/globals.css, the switch's colours in
     connect-mix.css, the map's dots in mix/worldMap.ts. The website's
     sapphire and sky blocks are deliberately not read.
   ============================================================ */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..");
const OUT = join(EXT, "tokens.css");

/* Where the website is: HPROXY_WEBSITE (a folder holding app/globals.css)
   names it; without it the website's checkout is looked for beside this
   repository, then one folder up. */
const CANDIDATES = [
  process.env.HPROXY_WEBSITE ? join(process.env.HPROXY_WEBSITE, "app", "globals.css") : null,
  join(EXT, "..", "..", "Hproxy", "hproxy-website", "app", "globals.css"),
  join(EXT, "..", "hproxy-website", "app", "globals.css"),
].filter(Boolean);
const SOURCE = CANDIDATES.find((p) => existsSync(p)) ?? CANDIDATES[0];
/* Written into tokens.css; the same on every machine, so moving folders
   never makes the file look stale. */
const STAMP = "hproxy-website/app/globals.css";

/* The computer app, in this repository. */
const APP = join(EXT, "..", "desktop-app", "src");
const APP_GLOBALS = join(APP, "styles", "globals.css");
const APP_MIX = join(APP, "styles", "connect-mix.css");
const APP_MAP = join(APP, "components", "connect", "mix", "worldMap.ts");

/* What the popup takes from the app's dark look. A list, because those blocks
   also carry see-through tokens the popup must never be able to name. */
const DARK = [
  "canvas",
  "surface",
  "raised",
  "hover",
  "hairline",
  "divider",
  "bar",
  "ink",
  "ink-mute",
  "ink-soft",
  "digi",
  "digi-deep",
  "digi-night",
  "digi-light",
  "accent-ink",
  "ok",
  "warn",
  "danger",
];
/* The same names for the white look, where the website has no word for them. */
const WHITE_EXTRA = ["raised", "hover", "divider", "accent-ink"];

/* Tokens that also get an `--x-rgb: r, g, b` companion, so a stylesheet can
   write rgba(var(--digi-rgb), 0.07) instead of hand-typing "1, 88, 255".
   Every one of those hand-typed triples is a copy that can go stale the same
   way the status colours did. */
const NEEDS_RGB = ["digi", "digi-deep", "digi-night", "digi-light", "ink", "ok", "warn", "danger"];

/* Read one selector's block. Brace-counting rather than a regex, because a
   comment inside the block contains braces and a lazy match stops early. */
function blockOf(css, selector, from) {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`no ${selector} block in ${from}`);
  const open = css.indexOf("{", start);
  if (open === -1) throw new Error(`malformed ${selector} block in ${from}`);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated ${selector} block in ${from}`);
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

/* The declarations of a block by name, without the leading dashes. */
function named(block) {
  return new Map(declarations(block).map(([name, value]) => [name.slice(2), value]));
}

function picked(names, ...blocks) {
  return names.map((name) => {
    const hit = blocks.map((b) => b.get(name)).find(Boolean);
    if (!hit) throw new Error(`the computer app has no --${name}`);
    return [`--${name}`, hit];
  });
}

/* One tone of the map (worldMap.ts, TONES): a dot's colour. */
function tone(source, name, field) {
  const line = source.match(new RegExp(`^\\s*${name}: \\{[^}]*\\}`, "m"))?.[0];
  const hex = line?.match(new RegExp(`${field}: "(#[0-9a-f]{6})"`, "i"))?.[1];
  if (!hex) throw new Error(`no ${name}.${field} in ${APP_MAP}`);
  return hex;
}

/* Everything the popup reads from the computer app. */
function fromApp() {
  const globals = readFileSync(APP_GLOBALS, "utf8");
  const mix = readFileSync(APP_MIX, "utf8");
  const map = readFileSync(APP_MAP, "utf8");
  const root = named(blockOf(globals, ":root", APP_GLOBALS));
  const clean = named(blockOf(globals, 'html[data-surface="clean"] {', APP_GLOBALS));
  const midnight = named(blockOf(globals, '[data-theme="midnight"] {', APP_GLOBALS));
  const graphite = named(blockOf(globals, 'html[data-surface][data-theme="midnight"] {', APP_GLOBALS));
  const blue = named(blockOf(mix, ".mix {", APP_MIX));
  const red = named(blockOf(mix, ".mix[data-failing] {", APP_MIX));
  return {
    white: [
      ...picked(WHITE_EXTRA, clean, root),
      ["--map-land", tone(map, "light", "base")],
      ["--map-lit", tone(map, "light", "near")],
    ],
    dark: [
      ...picked(DARK, graphite, midnight),
      ["--map-land", tone(map, "dark", "base")],
      ["--map-lit", tone(map, "dark", "near")],
    ],
    both: [
      ["--flood", blue.get("mix-blue")],
      ["--flood-deep", blue.get("mix-blue-deep")],
      ["--flood-words", blue.get("mix-on-blue")],
      ["--stop", red.get("mix-blue")],
      ["--stop-deep", red.get("mix-blue-deep")],
      ["--stop-words", red.get("mix-on-blue")],
      ["--map-flood-land", tone(map, "blue", "base")],
      ["--map-flood-lit", tone(map, "blue", "near")],
      ["--map-stop-land", tone(map, "red", "base")],
      ["--map-stop-lit", tone(map, "red", "near")],
    ],
  };
}

function push(lines, tokens) {
  for (const [name, value] of tokens) {
    lines.push(`  ${name}: ${value};`);
    const rgb = NEEDS_RGB.includes(name.slice(2)) ? hexToRgb(value) : null;
    if (rgb) lines.push(`  ${name}-rgb: ${rgb};`);
  }
}

function render(tokens, app) {
  const stamp = STAMP;
  const lines = [
    "/* ============================================================",
    "   GENERATED FILE — DO NOT EDIT BY HAND.",
    "",
    `   Source:    ${stamp}, and the computer app's files in this repo`,
    "   Regenerate: node scripts/sync-tokens.mjs   (build.ps1 runs this)",
    "",
    "   Every colour the popup is allowed to use lives here, copied",
    "   from the website's :root and the computer app's dark look at",
    "   build time. Editing this file by hand recreates exactly the",
    "   drift it exists to prevent: the next build silently overwrites",
    "   you.",
    "",
    "   Need a new colour? Add it to the website's globals.css or the",
    "   app's styles. Those are the only doors, deliberately.",
    "   ============================================================ */",
    ":root {",
    "  /* The white look. The popup never follows the OS scheme: the choice is",
    "     in its Settings page. This lock stops a dark-OS browser from",
    "     dark-ifying inputs and scrollbars. */",
    "  color-scheme: light;",
    "",
  ];

  push(lines, tokens);
  lines.push("", "  /* The computer app's, for what the website has no word for. */");
  push(lines, app.white);
  lines.push("", "  /* The flood, the switch and the map on it: the same in both looks. */");
  push(lines, app.both);

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
    "/* The dark look, the default: the computer app's Graphite. */",
    'html[data-theme="midnight"] {',
    "  color-scheme: dark;",
    "",
  );
  push(lines, app.dark);
  lines.push("}", "");
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

const tokens = declarations(blockOf(readFileSync(SOURCE, "utf8"), ":root", SOURCE));
const next = render(tokens, fromApp());
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
