/* ============================================================
   NOTHING SEE-THROUGH  ·  node scripts/check-see-through.mjs [--check]
   The house rule since 2026-09-26, for every product: a FILL (a
   background) is brand blue, ink or white at full strength, or the
   look's own solid neutral; never see-through, never a pale tint,
   never glass. The same test as the website's
   (hproxy-website/scripts/check-see-through.mjs):
     · a translucent fill: bg-white/20, bg-[rgb(1_2_3/0.4)], and in
       CSS a background with rgba() below 1 or an 8-digit hex
     · a colour mixed into a fill: color-mix() in a background (mixed
       with transparent it is see-through; mixed with white it is a
       pale tint that reads the same)
     · a pale fill: #e6eeff and the like (every channel at 208 or
       more, not white), Tailwind's bg-blue-50 ... bg-*-200
     · glass: backdrop-blur, backdrop-filter
   Since 2026-10-02 a fill is also read where the old check could not
   see it: on the lines after `background:` when the value continues
   there, and in a background variable (`--page-bg`, `--bg-*`). Aura's
   blue haze sat in one, the drop veil's 95 % blue on the next line.
   Allowed, as on the website: LINES and WORDS may use opacity, and
   the dimmed page behind an open dialog (data-scrim). A CSS line that
   is a line, a moving sheen or a press ripple, not a fill, says so on
   the same line: `see-through: allowed, <why>`.
   The whole app is held at ZERO: `--check` (in `npm run build`)
   fails on any hit. Emergency hatch: SEE_THROUGH_SKIP=1.
   ============================================================ */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const SCAN = ["src"];
const EXT = new Set([".tsx", ".ts", ".jsx", ".js", ".css"]);

const CLASS = /(?:^|[\s"'`{(])((?:[a-z0-9-]+:)*bg-(?:\[[^\]\s]+\]|[a-z]+(?:-[a-z0-9]+)*)(?:\/(?:\[[^\]\s]+\]|\d+(?:\.\d+)?))?)(?=$|[\s"'`})])/g;
const PALE_TW = /^bg-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200)$/;

function paleHex(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const white = r === 255 && g === 255 && b === 255;
  return !white && r >= 208 && g >= 208 && b >= 208;
}

function judgeClass(token) {
  const base = token.replace(/^(?:[a-z0-9-]+:)*/, "");
  if (/^bg-.+\/(?:\[[^\]]+\]|\d+(?:\.\d+)?)$/.test(base)) return "translucent fill";
  if (/^bg-\[color-mix\(/.test(base)) return "mixed colour fill";
  if (/^bg-\[(?:rgba?|hsla?)\([^\]]*\/[^\]]*\)\]$/.test(base)) return "translucent fill";
  const hex = base.match(/^bg-\[(#[0-9a-fA-F]{3,6})\]$/);
  if (hex && paleHex(hex[1])) return "pale fill";
  if (PALE_TW.test(base)) return "pale fill";
  return null;
}

function judgeLine(line, isCss) {
  const hits = [];
  if (line.includes("data-scrim") || line.includes("see-through: allowed")) return hits;
  if (/backdrop-blur|backdrop-filter/.test(line)) hits.push({ what: "glass", text: line.trim().slice(0, 140) });
  if (isCss) {
    const m = line.match(/background(?:-color)?\s*:\s*([^;]+)/);
    if (m) {
      const v = m[1];
      const translucent = /rgba?\([^)]*[,/]\s*0?\.\d+\s*\)/.test(v) || /#[0-9a-fA-F]{8}\b/.test(v) || /color-mix\(/.test(v);
      const pale = (v.match(/#[0-9a-fA-F]{3,6}\b/g) ?? []).some(paleHex);
      if (translucent || pale) hits.push({ what: translucent ? "translucent or mixed fill" : "pale fill", text: line.trim().slice(0, 140) });
    }
    return hits;
  }
  for (const m of line.matchAll(CLASS)) {
    const why = judgeClass(m[1]);
    if (why) hits.push({ what: why, text: m[1] });
  }
  return hits;
}

/* A disabled control faded with opacity turns its blue fill see-through blue
   (2026-10-01: the disabled Add button at 45%). Disabled controls are drawn
   solid instead: grey words, a grey tick, a hairline. In CSS, an opacity
   below 1 in a rule for a disabled state; in a component, a Tailwind
   opacity class next to "disabled". An icon or words without a fill may say
   `see-through: allowed, <why>` on the line. */
function judgeDisabledFade(line, css, selector) {
  if (/see-through:\s*allowed/.test(line)) return [];
  if (css) {
    const fade = /^\s*opacity:\s*(?:0?\.\d+|0)\s*;/.test(line);
    if (fade && /:disabled|\[disabled\]|\.is-disabled|aria-disabled/.test(selector)) {
      return [{ what: "faded disabled control", text: `${selector.trim()} ${line.trim()}`.slice(0, 140) }];
    }
    return [];
  }
  if (/disabled/.test(line) && /\bopacity-(?:\d+|\[)/.test(line)) return [{ what: "faded disabled control", text: line.trim().slice(0, 140) }];
  return [];
}

/* A fill's value where judgeLine does not look: the lines a `background`
   declaration continues on, and a background variable's declaration (named
   bg or background), on its first line and the ones after. A see-through
   colour there is the same fill. Lines inside a crisp pattern use solid
   colours and `transparent` gaps, which show the solid page: allowed. */
const FILL_PROP = /^(?:background(?:-color|-image)?|--(?:[\w-]*-)?(?:bg|background)(?:-[\w-]*)?)$/;
function judgeFillValue(line, prop, firstLine) {
  if (!prop || !FILL_PROP.test(prop)) return [];
  if (line.includes("see-through: allowed")) return [];
  // judgeLine already reads a `background:` line itself.
  if (firstLine && !prop.startsWith("--")) return [];
  const v = firstLine ? line.slice(line.indexOf(":") + 1) : line;
  const translucent = /rgba?\([^)]*[,/]\s*0?\.\d+\s*\)/.test(v) || /#[0-9a-fA-F]{8}\b/.test(v) || /color-mix\(/.test(v);
  return translucent ? [{ what: "translucent or mixed fill", text: `${prop}: ${line.trim()}`.slice(0, 140) }] : [];
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      await walk(full, out);
    } else if (EXT.has(path.extname(e.name))) out.push(full);
  }
}

const files = [];
for (const d of SCAN) await walk(path.join(ROOT, d), files);
const hits = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  const lines = (await readFile(f, "utf8")).split(/\r?\n/);
  const css = f.endsWith(".css");
  // The rule a CSS line belongs to: the last line that opened one.
  let selector = "";
  // The declaration a CSS line belongs to while its value runs on.
  let prop = null;
  lines.forEach((line, i) => {
    if (css && /\{\s*$/.test(line)) selector = line;
    for (const h of judgeLine(line, css)) hits.push({ file: rel, line: i + 1, ...h });
    for (const h of judgeDisabledFade(line, css, selector)) hits.push({ file: rel, line: i + 1, ...h });
    if (!css) return;
    const start = line.match(/^\s*(--[\w-]+|[a-z-]+)\s*:(?!:)/);
    const first = !!start && !/\{\s*$/.test(line);
    if (first) prop = start[1];
    for (const h of judgeFillValue(line, prop, first)) hits.push({ file: rel, line: i + 1, ...h });
    // A value ends at its semicolon, or where its rule does.
    if (/;\s*(?:\/\*.*\*\/\s*)?$/.test(line) || /[{}]\s*$/.test(line)) prop = null;
  });
}

const list = hits.map((h) => `  ${h.file}:${h.line}  ${h.what}  ${h.text}`).join("\n");
if (process.argv.includes("--check")) {
  if (process.env.SEE_THROUGH_SKIP === "1") {
    console.log("see-through: skipped (SEE_THROUGH_SKIP=1).");
    process.exit(0);
  }
  if (hits.length) {
    console.error(
      `\nsee-through: ${hits.length} fill(s) the app must not have. A fill is brand blue, ink, white or the look's solid neutral, never see-through, a pale tint or glass (house rule).\n${list}\n` +
        "Use the solid colour, change the words' colour, or show a hairline. A line, a moving sheen or a press ripple may stay: say `see-through: allowed, <why>` on its line.\nEmergency hatch: SEE_THROUGH_SKIP=1\n",
    );
    process.exit(1);
  }
  console.log("see-through: ok (the app is held at zero).");
  process.exit(0);
}
console.log(`see-through fills in the app: ${hits.length}`);
if (hits.length) console.log(list);
