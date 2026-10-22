/* ============================================================
   usage.js: the usage counts' book, kept the way the computer
   app and the phone keep theirs (proxy-engine/hproxy-api,
   usage.rs): asked once, nothing counted before a yes, one
   report a day about the day before, holding counts and words
   from fixed lists only. What a report holds: PRIVACY.md,
   "Usage counts". The worker (background.js) is the only one
   that writes the book; the popup asks it.

   A plain script that sets one global, not a module: the worker
   is a classic one and cannot import.
   ============================================================ */

(() => {
  /** Why a connection failed, in the server's words; anything else is "other". */
  const FAILURES = ["timeout", "login", "refused", "dns", "tls", "blocked", "other"];
  /** What a copy used, by the server's names; a name off the list is not counted. */
  const FEATURES = [
    "groups",
    "rotation",
    "new_ip",
    "free",
    "checker",
    "fraud_score",
    "leak_checks",
    "speed_test",
    "timezone",
    "system_proxy",
    "app_rules",
    "firewall",
    "expiry",
    "notes",
    "search",
    "import_file",
    "mcp",
  ];
  /** Where a crash happened, in the server's words; anything else is "other". */
  const CRASHES = ["engine", "window", "network", "storage", "other"];
  /** The most a count of one day can be: the server's bound. */
  const MOST = 100000;
  /** How many finished days back a report may still be sent (the server takes 7). */
  const DAYS_BACK = 6;

  const word = (w, list) => {
    const x = String(w ?? "").trim().toLowerCase();
    return list.includes(x) ? x : list[list.length - 1];
  };

  /** A size as the server takes it: never the exact length. */
  function bucket(n) {
    if (n <= 0) return "0";
    if (n === 1) return "1";
    if (n <= 10) return "2-10";
    if (n <= 100) return "11-100";
    if (n <= 1000) return "101-1000";
    return "1001+";
  }

  /** Days since 1970-01-01 of a day written YYYY-MM-DD, or null. */
  function dayNumber(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Math.round(Date.UTC(y, mo - 1, d) / 86400000);
  }

  /** Today on this computer's own calendar. */
  function today(now = new Date()) {
    const two = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  }

  function fresh(answer = "unasked") {
    return { answer, days: {}, sent: [], last: null };
  }

  /** The book as kept in storage; anything unreadable starts unasked. */
  function load(raw) {
    if (!raw || typeof raw !== "object" || !["unasked", "yes", "no"].includes(raw.answer)) return fresh();
    const book = fresh(raw.answer);
    if (raw.answer === "yes" && typeof raw.copy === "string" && /^[0-9a-f]{32}$/.test(raw.copy)) book.copy = raw.copy;
    if (raw.days && typeof raw.days === "object") {
      for (const [d, c] of Object.entries(raw.days)) if (dayNumber(d) !== null && c && typeof c === "object") book.days[d] = { ...emptyDay(), ...c };
    }
    if (Array.isArray(raw.sent)) book.sent = raw.sent.filter((d) => dayNumber(d) !== null);
    if (raw.last && typeof raw.last === "object") book.last = raw.last;
    return book;
  }

  /** 16 random bytes as 32 hex digits: tied to nothing but this copy. */
  function randomCopy() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** The person's answer. Yes makes this copy's number (once); no forgets everything. */
  function setAnswer(book, yes, makeCopy = randomCopy) {
    if (yes) {
      book.answer = "yes";
      if (!book.copy) book.copy = makeCopy();
    } else {
      for (const k of Object.keys(book)) delete book[k];
      Object.assign(book, fresh("no"));
    }
    return book;
  }

  function emptyDay() {
    return { opened: 0, connectsOk: 0, failed: {}, checkRuns: 0, checkMost: 0, saved: 0, groups: 0, free: 0, features: [], crashes: {} };
  }

  /** Count `event` on `day`. Nothing while the answer is not yes. */
  function count(book, day, event) {
    if (book.answer !== "yes" || dayNumber(day) === null || !event) return book;
    const c = (book.days[day] ??= emptyDay());
    const add = (key) => (c[key] = Math.min((c[key] || 0) + 1, MOST));
    const addIn = (map, key) => (map[key] = Math.min((map[key] || 0) + 1, MOST));
    const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
    switch (event.kind) {
      case "opened":
        add("opened");
        break;
      case "connectOk":
        add("connectsOk");
        break;
      case "connectFailed":
        addIn(c.failed, word(event.reason, FAILURES));
        break;
      case "checkRun":
        add("checkRuns");
        c.checkMost = Math.max(c.checkMost, n(event.proxies));
        break;
      case "kept":
        c.saved = n(event.proxies);
        c.groups = Math.min(n(event.groups), MOST);
        break;
      case "freeUsed":
        add("free");
        break;
      case "feature":
        if (FEATURES.includes(event.name) && !c.features.includes(event.name)) c.features = [...c.features, event.name].sort();
        break;
      case "crash":
        addIn(c.crashes, word(event.part, CRASHES));
        break;
    }
    return book;
  }

  /** A report in the server's shape (hproxy-backend routes/app_usage.rs read_report). */
  function report(copy, day, c, about) {
    return {
      copy,
      app: about.app,
      os: about.os,
      version: about.version,
      day,
      opened: c.opened,
      connects: { ok: c.connectsOk, failed: c.failed },
      checks: { runs: c.checkRuns, proxies: c.checkRuns > 0 ? bucket(c.checkMost) : "0" },
      saved: bucket(c.saved),
      groups: c.groups,
      free: c.free,
      features: c.features,
      crashes: c.crashes,
    };
  }

  /** The finished days not sent yet (before `day`, at most DAYS_BACK back), each as its report. */
  function due(book, day, about) {
    const t = dayNumber(day);
    if (book.answer !== "yes" || !book.copy || t === null) return [];
    return Object.keys(book.days)
      .sort()
      .filter((d) => !book.sent.includes(d))
      .filter((d) => {
        const n = dayNumber(d);
        return n !== null && n < t && n >= t - DAYS_BACK;
      })
      .map((d) => [d, report(book.copy, d, book.days[d], about)]);
  }

  /** `day` went out as `sent`: never again, and it is what the popup shows. Days too old are forgotten. */
  function markSent(book, day, sent, todayDay) {
    if (!book.sent.includes(day)) book.sent.push(day);
    book.last = sent;
    const t = dayNumber(todayDay);
    if (t !== null) {
      const keep = (d) => {
        const n = dayNumber(d);
        return n !== null && n >= t - DAYS_BACK - 1;
      };
      for (const d of Object.keys(book.days)) if (!keep(d)) delete book.days[d];
      book.sent = book.sent.filter(keep).sort();
    }
    return book;
  }

  /** The system, in the server's words, from `chrome.runtime.getPlatformInfo().os`. */
  function osWord(platformOs) {
    return { win: "windows", mac: "macos", linux: "linux", cros: "chromeos", android: "android" }[platformOs] || "other";
  }

  globalThis.HPROXY_USAGE = { FAILURES, FEATURES, CRASHES, bucket, dayNumber, today, fresh, load, setAnswer, count, report, due, markSent, osWord };
})();
