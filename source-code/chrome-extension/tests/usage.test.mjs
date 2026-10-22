// usage.js, kept the way the apps' engine keeps its book (proxy-engine/hproxy-api, usage.rs):
// the same answers, the same report, the same days.
import { test } from "node:test";
import assert from "node:assert/strict";

await import("../usage.js");
const U = globalThis.HPROXY_USAGE;
const ABOUT = { app: "extension", os: "windows", version: "1.0.6" };
const yes = () => U.setAnswer(U.fresh(), true);

test("nothing is counted or sent without a yes", () => {
  for (const answer of [null, false]) {
    const b = U.fresh();
    if (answer !== null) U.setAnswer(b, answer);
    U.count(b, "2026-10-14", { kind: "opened" });
    assert.deepEqual(b.days, {});
    assert.deepEqual(U.due(b, "2026-10-15", ABOUT), []);
    assert.equal(b.copy, undefined);
  }
});

test("a yes makes one number and a no forgets everything", () => {
  const b = yes();
  const copy = b.copy;
  assert.match(copy, /^[0-9a-f]{32}$/);
  U.setAnswer(b, true);
  assert.equal(b.copy, copy, "a second yes keeps the number");
  U.count(b, "2026-10-14", { kind: "opened" });
  U.setAnswer(b, false);
  assert.deepEqual(b, U.fresh("no"));
  U.setAnswer(b, true);
  assert.notEqual(b.copy, copy, "a later yes makes a new one");
});

test("a day becomes the report the server takes, exactly as the engine builds it", () => {
  const b = yes();
  const day = "2026-10-14";
  for (const e of [
    { kind: "opened" },
    { kind: "opened" },
    { kind: "connectOk" },
    { kind: "connectFailed", reason: "timeout" },
    { kind: "connectFailed", reason: "Something New" },
    { kind: "checkRun", proxies: 300 },
    { kind: "checkRun", proxies: 12 },
    { kind: "kept", proxies: 301, groups: 2 },
    { kind: "freeUsed" },
    { kind: "feature", name: "expiry" },
    { kind: "feature", name: "expiry" },
    { kind: "feature", name: "made-up" },
    { kind: "crash", part: "engine" },
  ]) {
    U.count(b, day, e);
  }
  const due = U.due(b, "2026-10-15", ABOUT);
  assert.equal(due.length, 1);
  const [d, r] = due[0];
  assert.equal(d, day);
  assert.deepEqual(r, {
    copy: b.copy,
    app: "extension",
    os: "windows",
    version: "1.0.6",
    day,
    opened: 2,
    connects: { ok: 1, failed: { timeout: 1, other: 1 } },
    checks: { runs: 2, proxies: "101-1000" },
    saved: "101-1000",
    groups: 2,
    free: 1,
    features: ["expiry"],
    crashes: { engine: 1 },
  });
});

test("only finished days not yet sent go, and a week at most", () => {
  const b = yes();
  for (const day of ["2026-10-01", "2026-10-09", "2026-10-13", "2026-10-14", "2026-10-15"]) U.count(b, day, { kind: "opened" });
  const days = (book) => U.due(book, "2026-10-15", ABOUT).map(([d]) => d);
  assert.deepEqual(days(b), ["2026-10-09", "2026-10-13", "2026-10-14"], "not today, not two weeks back");
  const [d, r] = U.due(b, "2026-10-15", ABOUT)[0];
  U.markSent(b, d, r, "2026-10-15");
  assert.deepEqual(b.last, r, "what the popup shows");
  assert.equal(b.days["2026-10-01"], undefined, "too old to send: forgotten");
  assert.deepEqual(days(b), ["2026-10-13", "2026-10-14"]);
});

test("a busy day stops at the server's bound and sizes go in buckets", () => {
  const b = yes();
  b.days["2026-10-14"] = { ...U.load({ answer: "yes", days: { "2026-10-14": { opened: 100000 } } }).days["2026-10-14"] };
  U.count(b, "2026-10-14", { kind: "opened" });
  assert.equal(b.days["2026-10-14"].opened, 100000);
  assert.deepEqual(
    [0, 1, 2, 10, 11, 100, 101, 1000, 1001].map(U.bucket),
    ["0", "1", "2-10", "2-10", "11-100", "11-100", "101-1000", "101-1000", "1001+"],
  );
});

test("a book that does not read starts unasked, and a kept one reads back", () => {
  for (const raw of [undefined, null, "x", { answer: "maybe" }]) assert.deepEqual(U.load(raw), U.fresh());
  const b = yes();
  U.count(b, "2026-10-14", { kind: "opened" });
  assert.deepEqual(U.load(JSON.parse(JSON.stringify(b))), b);
});

test("days count on the calendar, and the system is said in the server's words", () => {
  assert.equal(U.dayNumber("1970-01-01"), 0);
  assert.equal(U.dayNumber("2026-10-15") - U.dayNumber("2026-10-08"), 7);
  assert.equal(U.dayNumber("2028-03-01") - U.dayNumber("2028-02-28"), 2);
  assert.equal(U.dayNumber("15.10.2026"), null);
  assert.equal(U.today(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.deepEqual(["win", "mac", "linux", "cros", "android", "openbsd"].map(U.osWord), ["windows", "macos", "linux", "chromeos", "android", "other"]);
});
