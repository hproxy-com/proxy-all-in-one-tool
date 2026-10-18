/* ============================================================
   expiry.js: the day a saved proxy expires, read the same way
   in the popup (popup.html loads it before popup.js) and in the
   worker (background.js, importScripts), and the same way as the
   computer app's library reads it (proxy-engine/hproxy-places,
   clean_date and days_left): one day of the calendar written
   YYYY-MM-DD, counted on this computer's own calendar.

   A plain script that sets one global, not a module: the worker
   is a classic one and cannot import.
   ============================================================ */

(() => {
  /** [year, month, day] of a day written YYYY-MM-DD (2000 to 2199), or null. */
  function ymd(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || "").trim());
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 2000 || y > 2199 || mo < 1 || mo > 12) return null;
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return d >= 1 && d <= last ? [y, mo, d] : null;
  }

  /** `day` when it is one day of the calendar, else null. */
  const cleanDate = (day) => (ymd(day) ? String(day).trim() : null);

  /** Today on this computer's own calendar. */
  function todayHere(now = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /** Days from `today` to the last day `expires`: 0 on that day, below 0 once past. */
  function daysLeft(expires, today) {
    const a = ymd(expires);
    const b = ymd(today);
    if (!a || !b) return null;
    return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000);
  }

  /** How many days before its last day a proxy counts as expiring soon. */
  const SOON = 3;

  /** How a last day stands: quiet with time left, warn in its last three
      days, bad once past (and still usable: plans are extended). */
  function expiryOf(expires, today = todayHere()) {
    if (!expires) return null;
    const days = daysLeft(expires, today);
    if (days == null) return null;
    if (days < 0) return { days, words: "Expired", tone: "bad" };
    if (days === 0) return { days, words: "Expires today", tone: "warn" };
    if (days <= SOON) return { days, words: days === 1 ? "1 day left" : `${days} days left`, tone: "warn" };
    return { days, words: `${days} days left`, tone: "quiet" };
  }

  /** "12 Nov", or "12 Nov 2027" in another year. */
  function dayWords(day, today = todayHere()) {
    const a = ymd(day);
    if (!a) return String(day || "");
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][a[1] - 1];
    return `${a[2]} ${month}${String(a[0]) === String(today).slice(0, 4) ? "" : ` ${a[0]}`}`;
  }

  globalThis.HPROXY_EXPIRY = Object.freeze({ cleanDate, todayHere, daysLeft, expiryOf, dayWords, SOON });
})();
