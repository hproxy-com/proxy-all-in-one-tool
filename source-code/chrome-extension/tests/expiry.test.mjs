// expiry.js, read the way the computer app's library reads a last day.
import { test } from "node:test";
import assert from "node:assert/strict";

await import("../expiry.js");
const { cleanDate, daysLeft, expiryOf, dayWords } = globalThis.HPROXY_EXPIRY;

test("a last day is one day of the calendar written year-month-day", () => {
  assert.equal(cleanDate("2026-11-14"), "2026-11-14");
  assert.equal(cleanDate("2028-02-29"), "2028-02-29");
  for (const wrong of ["2026-02-29", "2026-04-31", "2026-13-01", "14.11.2026", "1999-12-31", "", undefined]) {
    assert.equal(cleanDate(wrong), null, String(wrong));
  }
});

test("days are calendar days: 0 on the last day, below 0 once past", () => {
  assert.equal(daysLeft("2026-11-14", "2026-11-14"), 0);
  assert.equal(daysLeft("2027-01-02", "2026-12-30"), 3);
  assert.equal(daysLeft("2028-03-01", "2028-02-28"), 2);
  assert.equal(daysLeft("2026-11-14", "2026-11-16"), -2);
});

test("quiet with time left, warn in the last three days, bad once past", () => {
  const today = "2026-11-10";
  assert.equal(expiryOf(undefined, today), null);
  assert.deepEqual(expiryOf("2026-11-22", today), { days: 12, words: "12 days left", tone: "quiet" });
  assert.deepEqual(expiryOf("2026-11-13", today), { days: 3, words: "3 days left", tone: "warn" });
  assert.deepEqual(expiryOf("2026-11-10", today), { days: 0, words: "Expires today", tone: "warn" });
  assert.deepEqual(expiryOf("2026-11-01", today), { days: -9, words: "Expired", tone: "bad" });
  assert.equal(dayWords("2027-01-02", "2026-10-15"), "2 Jan 2027");
  assert.equal(dayWords("2026-11-14", "2026-10-15"), "14 Nov");
});
