/* ============================================================
   verify-design.mjs — the extension cannot go off-system.

     node scripts/verify-design.mjs

   Five checks, each one earned by a bug that actually happened rather
   than by a style preference:

     1. tokens.css is current            the palette drifted for two days
                                         in July and nothing noticed
     2. no hex literals in popup.css     a hex is a copy, and copies are
                                         what drifted
     3. no hand-typed rgba() triples     "rgba(1, 88, 255, .07)" is the
                                         same copy wearing a disguise
     4. every var(--x) resolves          the site renamed --bad to
                                         --danger; a stale var() does not
                                         error, it silently renders black
     5. font sizes are on the ruler      36 distinct sizes against 13
                                         documented roles, measured on the
                                         website 2026-07-31

   White is exempt from 2 and 3. #fff is not a brand decision, it is the
   absence of one, and the popup is light-only so it cannot theme.

   An off-ruler size is allowed if the line carries `ruler-exempt: <why>`
   in a comment. Exceptions then live in the diff and get counted in the
   report, instead of accumulating silently. A comment cannot fail a
   build, so the comment is the declaration and this file is the check.
   ============================================================ */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..");
const TOKENS = join(EXT, "tokens.css");

/* The type ruler from hproxy-website/DESIGN.md, "The type ruler (the ONLY
   allowed sizes)". Floors: body copy never below 13px, 11 and 10 are labels
   only. Keep this list in step with that table. */
const RULER = new Set([10, 11, 12, 13, 13.5, 15]);

/* Stylesheets that must obey the rules. popup.js is scanned too: it sets
   colours inline via el.style.color = "var(--ok)". */
const SHEETS = ["popup.css"];
const SCRIPTS = ["popup.js", "analyzer.js"];

const problems = [];
const notes = [];

function fail(file, line, message) {
  problems.push(`${file}:${line}  ${message}`);
}

/* ── 1. tokens.css is current ───────────────────────────────────────── */

try {
  execFileSync(process.execPath, [join(HERE, "sync-tokens.mjs"), "--check"], { stdio: "pipe" });
  notes.push("tokens.css matches the website");
} catch {
  problems.push(
    "tokens.css  is STALE against hproxy-website/app/globals.css. " +
      "Run: node scripts/sync-tokens.mjs",
  );
}

if (!existsSync(TOKENS)) {
  console.error("verify-design: tokens.css is missing. Run: node scripts/sync-tokens.mjs");
  process.exit(1);
}

/* Every token the popup is allowed to name: the generated palette, plus any
   custom property the extension declares for itself. A stylesheet declares
   one with `--x:`; a script declares one with setProperty("--x", …), which is
   how the country rows get their stagger delay. Both count, or the check
   would report a property that is genuinely provided. */
const tokenCss = readFileSync(TOKENS, "utf8");
const DEFINED = new Set([...tokenCss.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));

for (const name of [...SHEETS, ...SCRIPTS]) {
  const path = join(EXT, name);
  if (!existsSync(path)) continue;
  const src = readFileSync(path, "utf8");
  for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:/gi)) DEFINED.add(m[1]);
  for (const m of src.matchAll(/setProperty\(\s*["'](--[a-z0-9-]+)["']/gi)) DEFINED.add(m[1]);
}

/* Strip comments so a comment that quotes an old hex (this file's own header
   quotes several) cannot be reported as a violation. Newlines are preserved
   so reported line numbers stay true. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

const WHITE_HEX = /^#(fff|ffffff)$/i;

for (const name of [...SHEETS, ...SCRIPTS]) {
  const path = join(EXT, name);
  if (!existsSync(path)) {
    problems.push(`${name}  is missing`);
    continue;
  }
  const isSheet = SHEETS.includes(name);
  const source = readFileSync(path, "utf8");
  /* Two views of the same file, and which one a check reads matters.
     Violations are scanned on the COMMENT-STRIPPED text, so a comment that
     quotes an old hex is not itself reported. Exemptions are read from the
     RAW text, because the exemption IS a comment: stripping first blanks the
     declaration before the check can see it, and every exemption then fails. */
  const raw = source.split(/\r?\n/);
  const lines = stripComments(source).split(/\r?\n/);

  lines.forEach((line, i) => {
    const n = i + 1;
    const exempt = /ruler-exempt:/.test(raw[i] ?? "");

    /* ── 2. hex literals ── */
    for (const m of line.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
      if (WHITE_HEX.test(m[0])) continue;
      fail(name, n, `hex literal ${m[0]} — name a token from tokens.css instead`);
    }

    /* ── 3. hand-typed colour triples ── */
    for (const m of line.matchAll(/\brgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*[,)]/gi)) {
      const [r, g, b] = [m[1], m[2], m[3]].map(Number);
      if (r === 255 && g === 255 && b === 255) continue; // white overlay
      fail(
        name,
        n,
        `hand-typed rgb triple (${r}, ${g}, ${b}) — use rgba(var(--<token>-rgb), a)`,
      );
    }

    /* ── 4. every var(--x) resolves ── */
    for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      const token = m[1];
      if (DEFINED.has(token)) continue;
      fail(name, n, `var(${token}) is defined nowhere — it renders as nothing, silently`);
    }

    /* ── 5. type ruler (stylesheets only) ── */
    if (isSheet) {
      for (const m of line.matchAll(/font-size:\s*([\d.]+)px/gi)) {
        const size = Number(m[1]);
        if (RULER.has(size)) continue;
        if (exempt) {
          notes.push(`${name}:${n} ruler exemption at ${size}px`);
          continue;
        }
        fail(
          name,
          n,
          `${size}px is not on the type ruler (${[...RULER].join(", ")}) — ` +
            "use a ruler size, or declare `ruler-exempt: <why>` on this line",
        );
      }
    }
  });
}

/* ── report ─────────────────────────────────────────────────────────── */

for (const note of notes) console.log(`  ok    ${note}`);

if (problems.length) {
  console.error(`\nverify-design: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  FAIL  ${p}`);
  console.error("");
  process.exit(1);
}

console.log(`\nverify-design: clean. ${DEFINED.size} tokens available, 0 off-system values.`);
