import { describe, expect, it } from "vitest";
import {
  NAME_EXAMPLES,
  REVIEW_TESTS,
  addLabels,
  countReview,
  linesToAdd,
  nameExample,
  namesPreview,
  numberedNames,
  reviewOrder,
  reviewStatus,
  testOf,
  type LineTest,
} from "./review";

const ok = (ms = 100): LineTest => ({ ok: true, ms });
const bad: LineTest = { ok: false, why: "connection refused" };
const tests = (pairs: [string, LineTest][]) => new Map(pairs);

describe("countReview", () => {
  it("is settled once every line answered, or the wait was skipped", () => {
    const lines = ["a", "b", "c"];
    const half = tests([["a", ok()], ["b", bad]]);
    expect(countReview(lines, half, false)).toMatchObject({ worked: 1, failed: 1, untested: 1, done: false, settled: false });
    expect(countReview(lines, half, true).settled).toBe(true);
    expect(countReview(lines, tests([["a", ok()], ["b", bad], ["c", ok()]]), false)).toMatchObject({ done: true, settled: true });
  });

  it("counts a long list as tested once its first REVIEW_TESTS answered", () => {
    const lines = Array.from({ length: REVIEW_TESTS + 5 }, (_, i) => `l${i}`);
    const all = new Map(lines.slice(0, REVIEW_TESTS).map((l) => [l, ok()] as const));
    expect(countReview(lines, all, false)).toMatchObject({ done: true, untested: 5 });
  });
});

describe("reviewOrder", () => {
  it("puts the working first, then the untested, the failed last, once settled", () => {
    const lines = ["dead", "fine", "later", "fine2"];
    const t = tests([["dead", bad], ["fine", ok()], ["fine2", ok()]]);
    expect(reviewOrder(lines, t, false)).toEqual(lines);
    expect(reviewOrder(lines, t, true)).toEqual(["fine", "fine2", "later", "dead"]);
  });
});

describe("reviewStatus and addLabels", () => {
  const status = (lines: string[], t: Map<string, LineTest>, skipped = false) => {
    const c = countReview(lines, t, skipped);
    return { words: reviewStatus(c), ...addLabels(c) };
  };

  it("says how many work while testing", () => {
    expect(reviewStatus(countReview(["a", "b"], tests([]), false))).toBe("Testing");
    expect(reviewStatus(countReview(["a", "b", "c"], tests([["a", ok()]]), false))).toBe("1 works · 0 failed");
  });

  it("offers only the ones that work, or all of them anyway", () => {
    const got = status(["a", "b", "c"], tests([["a", ok()], ["b", ok()], ["c", bad]]));
    expect(got).toEqual({ words: "2 work · 1 failed", main: "Add only the 2 that work", mainTakesFailed: false, anyway: "Add all 3 anyway" });
  });

  it("says all but the ones that failed when some were not tested", () => {
    const got = status(["a", "b", "c"], tests([["a", bad]]), true);
    expect(got.words).toBe("0 work · 1 failed · 2 not tested");
    expect(got.main).toBe("Add all but the one that failed");
  });

  it("adds them all at once when all work, and anyway when all failed", () => {
    expect(status(["a", "b"], tests([["a", ok()], ["b", ok()]]))).toMatchObject({ words: "Both work", main: "Add both", anyway: null });
    expect(status(["a"], tests([["a", bad]]))).toMatchObject({ words: "It failed", main: "Add anyway", mainTakesFailed: true });
    expect(status(["a", "b", "c"], tests([["a", bad], ["b", bad], ["c", bad]]))).toMatchObject({ words: "All 3 failed", main: "Add all 3 anyway" });
  });
});

describe("linesToAdd", () => {
  it("leaves out only the ones that failed", () => {
    expect(linesToAdd(["a", "b", "c"], tests([["a", bad], ["b", ok()]]), false)).toEqual(["b", "c"]);
    expect(linesToAdd(["a", "b"], tests([["a", bad]]), true)).toEqual(["a", "b"]);
  });
});

describe("names", () => {
  it("numbers one name for all, and keeps one proxy's name as it is", () => {
    expect(numberedNames(" Shop ", 3)).toEqual(["Shop 1", "Shop 2", "Shop 3"]);
    expect(numberedNames("Shop", 1)).toEqual(["Shop"]);
    expect(numberedNames("  ", 3)).toEqual([]);
    expect(namesPreview("Shop", 18)).toBe("Shop 1, Shop 2, Shop 3 … Shop 18");
    expect(namesPreview("Shop", 2)).toBe("Shop 1, Shop 2");
  });

  it("gives every box an example, a different one each", () => {
    expect(nameExample(0)).toBe(NAME_EXAMPLES[0]);
    expect(nameExample(NAME_EXAMPLES.length - 1, 1)).toBe(NAME_EXAMPLES[0]);
    expect(new Set(Array.from({ length: 4 }, (_, i) => nameExample(5, i))).size).toBe(4);
  });
});

describe("testOf", () => {
  it("keeps what the row shows", () => {
    expect(testOf({ input: "a", alive: false, error: "refused" })).toEqual({ ok: false, why: "refused" });
    expect(testOf({ input: "a", alive: true, latency_ms: 90, country_code: "DE", city: "Berlin", country: "Germany" })).toMatchObject({ ok: true, ms: 90, cc: "de" });
  });
});
