/* A pasted list, reviewed before it is added (components/connect/PasteReview.tsx): every line
   is read, then tested the way the paste field tests one (check_line), and the add step asks
   (2026-10-17, the paste lab's rounds 8 to 10, in the app since 2026-10-18): only the ones that
   work, or all of them anyway, because a proxy that does not answer may only be down a while.
   Then the names, one for all and numbered, or none. Plain functions, so the words can be tested
   without a window. */

import type { CheckResult } from "./checker";
import { placeOf, spacedN } from "./connect";

/** How many lines a review tests by itself; past it the rest is added untested (the Checker tests
    any number). The app keeps far more answers than this for the lines saved right after
    (src-tauri/src/places.rs, CHECKED_KEPT, 20 000). 200 until 2026-10-22, when a check got about
    three times faster (proxy-engine, check.rs fan_out and transport.rs climb) and a list of 300
    showed "100 not tested". */
export const REVIEW_TESTS = 1000;
/** How many at once (12 until 2026-10-22). */
export const REVIEW_AT_ONCE = 24;

/** Before the review: what Add's box says about what is in it, counting only the lines the engine
    read as proxies (since 2026-10-22; until then the box counted every line, a header or a
    half-typed one too). An empty box says nothing, and a line that is not a proxy is said when
    adding, in the review, where it blocks nothing. */
export function boxWords(ready: number): string {
  return ready ? `${spacedN(ready)} ready to test` : "";
}

/** The review's words for lines that are not proxies, left out of the test. */
export function notProxyWords(n: number): string {
  return n === 1 ? "1 line isn't a proxy" : `${spacedN(n)} lines aren't proxies`;
}

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
    pasted: "Add working (18)" takes the top of the list. Until then, the newest answer on top and
    the ones still waiting under them, as pasted (since 2026-10-22), so the progress is in sight.
    `tests` holds the answers in the order they came. */
export function reviewOrder(lines: string[], tests: ReadonlyMap<string, LineTest>, settled: boolean): string[] {
  if (!settled) {
    const here = new Set(lines);
    const answered = [...tests.keys()].filter((l) => here.has(l)).reverse();
    return [...answered, ...lines.filter((l) => !tests.has(l))];
  }
  return [...lines.filter((l) => tests.get(l)?.ok), ...lines.filter((l) => !tests.has(l)), ...lines.filter((l) => tests.get(l)?.ok === false)];
}

const works = (w: number) => `${spacedN(w)} ${w === 1 ? "works" : "work"}`;

/** The line over the list: what the test found so far, then what it found. The title over it says
    "Testing N proxies" meanwhile (2026-10-22), so before the first answer this line waits. */
export function reviewStatus(c: ReviewCount): string {
  const counted = `${works(c.worked)} · ${spacedN(c.failed)} failed`;
  const answered = c.worked + c.failed;
  if (!c.settled) return answered ? counted : c.n === 1 ? "Waiting for its answer" : "Waiting for the first answers";
  if (c.untested) return answered ? `${counted} · ${spacedN(c.untested)} not tested` : `${spacedN(c.untested)} not tested`;
  if (c.failed === c.n) return c.n === 1 ? "It failed" : c.n === 2 ? "Both failed" : `All ${c.n} failed`;
  if (c.failed) return counted;
  return c.n === 1 ? "It works" : c.n === 2 ? "Both work" : `All ${c.n} work`;
}

/** The add step's buttons: the main one leaves out the ones that failed, the second one takes all
    of them anyway; when all failed, adding them anyway is the only way on. Short, with the count
    in brackets (since 2026-10-22). */
export function addLabels(c: ReviewCount): { main: string; mainTakesFailed: boolean; anyway: string | null } {
  const anyway = c.n === 1 ? "Add anyway" : `Add all anyway (${spacedN(c.n)})`;
  if (c.failed === c.n) return { main: anyway, mainTakesFailed: true, anyway: null };
  if (!c.failed) return { main: c.n === 1 ? "Add it" : `Add all (${spacedN(c.n)})`, mainTakesFailed: true, anyway: null };
  const main = c.untested ? `Add all but the failed (${spacedN(c.n - c.failed)})` : `Add working (${spacedN(c.worked)})`;
  return { main, mainTakesFailed: false, anyway };
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

/** Real things people name proxies after, for the name boxes: a different one each time (since
    2026-10-18), so the box shows what a name is for. */
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
