/* A pasted list, reviewed before it is added (components/connect/PasteReview.tsx): every line
   is read, then tested the way the paste field tests one (check_line), and the add step asks
   (2026-10-17, the paste lab's rounds 8 to 10, in the app since 2026-10-18): only the ones that
   work, or all of them anyway, because a proxy that does not answer may only be down a while.
   Then the names, one for all and numbered, or none. Plain functions, so the words can be tested
   without a window. */

import type { CheckResult } from "./checker";
import { placeOf } from "./connect";

/** How many lines a review tests by itself; a longer list is the Checker's work, and its rest
    is added untested. The app keeps that many answers for the lines saved right after
    (src-tauri/src/places.rs, CHECKED_KEPT). */
export const REVIEW_TESTS = 200;
/** How many at once. */
export const REVIEW_AT_ONCE = 12;

/** What testing one line found. */
export type LineTest = { ok: boolean; ms?: number; cc?: string; place?: string; why?: string };

export function testOf(r: CheckResult): LineTest {
  if (!r.alive) return { ok: false, why: r.error ?? "the proxy did not answer" };
  return { ok: true, ms: r.latency_ms ?? undefined, cc: r.country_code?.toLowerCase() ?? undefined, place: placeOf(r) || undefined };
}

/** Where a review stands. `settled`: tested to the end, or the wait skipped: the add step is open. */
export type ReviewCount = { n: number; worked: number; failed: number; untested: number; done: boolean; settled: boolean };

export function countReview(lines: string[], tests: ReadonlyMap<string, LineTest>, skipped: boolean): ReviewCount {
  const n = lines.length;
  let worked = 0;
  let failed = 0;
  for (const l of lines) {
    const t = tests.get(l);
    if (t?.ok) worked += 1;
    else if (t) failed += 1;
  }
  const tested = Math.min(n, REVIEW_TESTS);
  const done = worked + failed >= tested;
  return { n, worked, failed, untested: n - worked - failed, done, settled: done || skipped };
}

/** Once settled, the ones that work first, then the untested, the failed last, each in the order
    pasted: "Add only the 18 that work" takes the top of the list. Until then, as pasted. */
export function reviewOrder(lines: string[], tests: ReadonlyMap<string, LineTest>, settled: boolean): string[] {
  if (!settled) return lines;
  return [...lines.filter((l) => tests.get(l)?.ok), ...lines.filter((l) => !tests.has(l)), ...lines.filter((l) => tests.get(l)?.ok === false)];
}

const works = (w: number) => `${w} ${w === 1 ? "works" : "work"}`;

/** The line over the list: what the test found so far, then what it found. */
export function reviewStatus(c: ReviewCount): string {
  const counted = `${works(c.worked)} · ${c.failed} failed`;
  const answered = c.worked + c.failed;
  if (!c.settled) return answered ? counted : "Testing";
  if (c.untested) return answered ? `${counted} · ${c.untested} not tested` : `${c.untested} not tested`;
  if (c.failed === c.n) return c.n === 1 ? "It failed" : c.n === 2 ? "Both failed" : `All ${c.n} failed`;
  if (c.failed) return counted;
  return c.n === 1 ? "It works" : c.n === 2 ? "Both work" : `All ${c.n} work`;
}

/** The add step's buttons: the main one leaves out the ones that failed, the second one takes all
    of them anyway; when all failed, adding them anyway is the only way on. */
export function addLabels(c: ReviewCount): { main: string; mainTakesFailed: boolean; anyway: string | null } {
  const every = c.n === 1 ? "Add it" : c.n === 2 ? "Add both" : `Add all ${c.n}`;
  if (c.failed === c.n) return { main: c.n === 1 ? "Add anyway" : `${every} anyway`, mainTakesFailed: true, anyway: null };
  if (!c.failed) return { main: every, mainTakesFailed: true, anyway: null };
  const main = c.untested
    ? c.failed === 1
      ? "Add all but the one that failed"
      : `Add all but the ${c.failed} that failed`
    : c.worked === 1
      ? "Add only the one that works"
      : `Add only the ${c.worked} that work`;
  return { main, mainTakesFailed: false, anyway: `${every} anyway` };
}

/** The lines an add takes: all of them, or all but the ones that failed. */
export function linesToAdd(lines: string[], tests: ReadonlyMap<string, LineTest>, takeFailed: boolean): string[] {
  return takeFailed ? lines : lines.filter((l) => tests.get(l)?.ok !== false);
}

/** One name for all, numbered: "Shop 1", "Shop 2" …; one proxy keeps the name as it is. */
export function numberedNames(base: string, count: number): string[] {
  const name = base.trim();
  if (!name || count <= 0) return [];
  return count === 1 ? [name] : Array.from({ length: count }, (_, i) => `${name} ${i + 1}`);
}

/** The names as the naming step shows them: all of a few, else the first three and the last. */
export function namesPreview(base: string, count: number): string {
  const names = numberedNames(base, count);
  return names.length <= 4 ? names.join(", ") : `${names.slice(0, 3).join(", ")} … ${names[names.length - 1]}`;
}

/** Real things people name proxies after, for the name boxes: a different one each time
    (2026-10-18: "the placeholder for name should make more sense, like Instagram account ...
    different placeholder every time"). */
export const NAME_EXAMPLES = [
  "Instagram account",
  "TikTok shop",
  "Sneaker bot",
  "eBay store",
  "Facebook ads",
  "Work laptop",
  "YouTube channel",
  "Amazon seller",
  "Reddit account",
  "Price checks",
  "Client A",
  "Shopify store",
  "Discord bot",
  "SEO tracking",
  "LinkedIn",
  "Gaming",
] as const;

/** An example name, from a seed picked when a screen opens. */
export const nameExample = (seed: number, i = 0): string => NAME_EXAMPLES[Math.abs(Math.floor(seed) + i) % NAME_EXAMPLES.length];
