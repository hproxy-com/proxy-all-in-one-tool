import { describe, expect, it } from "vitest";
import {
  FREE_COUNTRIES_KEEP_MS,
  FREE_LIST_KEEP_MS,
  FREE_TESTS_AT_ONCE,
  countWords,
  countryChoices,
  ensureFreeCountries,
  ensureFreeRun,
  failedRows,
  freeCountriesState,
  freeRun,
  matchCountries,
  onFreeCountries,
  onFreeRuns,
  rowPlace,
  rowsOf,
  runWords,
  testsLeft,
  withAnswer,
  withTesting,
  workingRows,
  type FreeDeps,
  type FreeRun,
} from "./freeList";
import type { FreeCountry, FreeExit, FreeTest } from "./tauri";

const exit = (host: string, more: Partial<FreeExit> = {}): FreeExit => ({
  host,
  port: 8080,
  country: "DE",
  city: "Frankfurt",
  network: "Example Hosting",
  latency_ms: 120,
  ...more,
});

/** Let every answer that is already there land. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Wait until `cond` holds, a short while at most. */
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(cond()).toBe(true);
};

describe("the rows", () => {
  it("lists each address once, all waiting", () => {
    const rows = rowsOf([exit("203.0.113.1"), exit("203.0.113.2"), exit("203.0.113.1")]);
    expect(rows.map((r) => r.addr)).toEqual(["203.0.113.1:8080", "203.0.113.2:8080"]);
    expect(rows.every((r) => r.state === "waiting")).toBe(true);
    // IPv6 in brackets, the way the relay writes an address.
    expect(rowsOf([exit("2001:db8::7", { port: 3128 })])[0].addr).toBe("[2001:db8::7]:3128");
  });

  it("lists the passes as they land while tests run, the fastest first once all have answered", () => {
    let rows = rowsOf([exit("203.0.113.1"), exit("203.0.113.2"), exit("203.0.113.3"), exit("203.0.113.4")]);
    rows = withTesting(rows, "203.0.113.3:8080");
    expect(rows[2].state).toBe("testing");
    expect(testsLeft(rows)).toBe(4);
    rows = withAnswer(rows, "203.0.113.3:8080", { ok: true, ms: 310 });
    rows = withAnswer(rows, "203.0.113.1:8080", { ok: false, why: "refused the connection" });
    rows = withAnswer(rows, "203.0.113.2:8080", { ok: true, ms: 95 });
    // One test still out: listed by when they passed, not by speed, so a row
    // that is shown does not move under the pointer.
    expect(workingRows(rows).map((r) => [r.addr, r.ms])).toEqual([
      ["203.0.113.3:8080", 310],
      ["203.0.113.2:8080", 95],
    ]);
    rows = withAnswer(rows, "203.0.113.4:8080", { ok: false, why: "  " });
    // Every test answered: the fastest first.
    expect(workingRows(rows).map((r) => [r.addr, r.ms])).toEqual([
      ["203.0.113.2:8080", 95],
      ["203.0.113.3:8080", 310],
    ]);
    expect(failedRows(rows).map((r) => r.why)).toEqual(["refused the connection", "did not work"]);
    expect(testsLeft(rows)).toBe(0);
  });

  it("says a row's place and network with what is known", () => {
    const [full] = rowsOf([exit("203.0.113.1")]);
    expect(rowPlace(full)).toBe("Frankfurt, Germany · Example Hosting");
    const [bare] = rowsOf([exit("203.0.113.2", { city: "", country: "", network: "" })]);
    expect(rowPlace(bare)).toBe("");
  });
});

describe("the line above the list", () => {
  const run = (over: Partial<FreeRun>): FreeRun => ({ id: 1, country: "DE", socks5: false, startedAt: 0, loading: false, error: null, rows: [], ...over });

  it("says what is happening, then how it went", () => {
    expect(runWords(undefined, "DE", false)).toBe("Getting the free HTTP proxies in Germany…");
    expect(runWords(run({ loading: true }), "", true)).toBe("Getting the free SOCKS5 proxies from every country…");
    expect(runWords(run({ error: "the HProxy pool answered 500" }), "DE", false)).toBe("The free list could not be loaded");
    expect(runWords(run({}), "DE", false)).toBe("The pool has no free HTTP proxy in Germany right now");

    let rows = rowsOf([exit("203.0.113.1"), exit("203.0.113.2"), exit("203.0.113.3")]);
    rows = withAnswer(rows, "203.0.113.1:8080", { ok: true, ms: 200 });
    expect(runWords(run({ rows }), "DE", false)).toBe("Testing 3 free HTTP proxies in Germany: 1 done, 1 working");
    rows = withAnswer(rows, "203.0.113.2:8080", { ok: false, why: "x" });
    rows = withAnswer(rows, "203.0.113.3:8080", { ok: false, why: "x" });
    expect(runWords(run({ rows }), "DE", false)).toBe("1 of 3 tested work from here right now");
    const none = rowsOf([exit("203.0.113.9")]).map((r) => ({ ...r, state: "bad" as const, why: "x" }));
    expect(runWords(run({ rows: none }), "DE", false)).toBe("None of the 1 tested works from here right now");
  });
});

describe("a run", () => {
  it("tests the whole list, never more than a few at once, and lists the passes", async () => {
    const hosts = Array.from({ length: 14 }, (_, i) => `198.51.100.${i + 1}`);
    let active = 0;
    let most = 0;
    const deps: FreeDeps = {
      list: async (country, socks5) => {
        expect([country, socks5]).toEqual(["NL", true]);
        return hosts.map((h) => exit(h, { country: "NL" }));
      },
      test: async (host) => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 1));
        active -= 1;
        return Number(host.split(".")[3]) % 3 === 0 ? { ok: true, ms: 100 } : { ok: false, why: "did not answer within 10 seconds" };
      },
    };
    const first = ensureFreeRun("NL", true, deps);
    expect(first.loading).toBe(true);
    await until(() => {
      const r = freeRun("NL", true);
      return !!r && !r.loading && testsLeft(r.rows) === 0;
    });
    const done = freeRun("NL", true)!;
    expect(done.loading).toBe(false);
    expect(testsLeft(done.rows)).toBe(0);
    expect(workingRows(done.rows).map((r) => r.exit.host).sort()).toEqual(["198.51.100.12", "198.51.100.3", "198.51.100.6", "198.51.100.9"]);
    expect(failedRows(done.rows)).toHaveLength(10);
    expect(most).toBe(FREE_TESTS_AT_ONCE);
  });

  it("shows a kept list again, and asks for a new batch once it is old or on request", async () => {
    let lists = 0;
    let clock = 1_000;
    const deps: FreeDeps = {
      list: async () => {
        lists += 1;
        return [exit("192.0.2.10", { country: "FR" })];
      },
      test: async () => ({ ok: true, ms: 80 }),
      now: () => clock,
    };
    const a = ensureFreeRun("FR", false, deps);
    await settle();
    expect(ensureFreeRun("FR", false, deps).id).toBe(a.id);
    expect(lists).toBe(1);
    clock += FREE_LIST_KEEP_MS;
    const b = ensureFreeRun("FR", false, deps);
    expect(b.id).not.toBe(a.id);
    await settle();
    const c = ensureFreeRun("FR", false, deps, true);
    expect(c.id).not.toBe(b.id);
    await settle();
    expect(lists).toBe(3);
  });

  it("drops the answers of a batch that was replaced", async () => {
    const waiting: ((t: FreeTest) => void)[] = [];
    const deps: FreeDeps = {
      list: async () => [exit("192.0.2.20", { country: "JP" })],
      test: () => new Promise<FreeTest>((done) => waiting.push(done)),
    };
    ensureFreeRun("JP", false, deps);
    await settle();
    expect(waiting).toHaveLength(1);
    const fresh = ensureFreeRun("JP", false, deps, true);
    await settle();
    // The first batch's test answers late: nothing of it may show.
    waiting[0]({ ok: true, ms: 50 });
    await settle();
    const now = freeRun("JP", false)!;
    expect(now.id).toBe(fresh.id);
    expect(workingRows(now.rows)).toHaveLength(0);
    expect(now.rows[0].state).toBe("testing");
    waiting[1]({ ok: true, ms: 70 });
    await settle();
    expect(workingRows(freeRun("JP", false)!.rows).map((r) => r.ms)).toEqual([70]);
  });

  it("says why when the pool gives no list, and tells the screen about every change", async () => {
    let changes = 0;
    const stop = onFreeRuns(() => (changes += 1));
    ensureFreeRun("BR", false, {
      list: async () => {
        throw "the free pool's quota for your network is used up";
      },
      test: async () => ({ ok: true }),
    });
    await settle();
    stop();
    const r = freeRun("BR", false)!;
    expect(r.loading).toBe(false);
    expect(r.error).toBe("the free pool's quota for your network is used up");
    expect(changes).toBe(2);
  });
});

describe("the country menu", () => {
  const pool: FreeCountry[] = [
    { code: "US", count: 1612 },
    { code: "ID", count: 1040 },
    { code: "IN", count: 130 },
    { code: "DE", count: 102 },
    { code: "AR", count: 65 },
    { code: "CN", count: 306 },
    { code: "KH", count: 34 },
  ];

  it("offers Anywhere, then every country of the pool the most first, and always the one chosen", () => {
    const choices = countryChoices(pool, "JP");
    expect(choices[0]).toEqual({ code: "", name: "Anywhere", count: 3289 });
    expect(choices.slice(1, 4).map((c) => [c.code, c.name, c.count])).toEqual([
      ["US", "United States", 1612],
      ["ID", "Indonesia", 1040],
      ["IN", "India", 130],
    ]);
    // A code the app's own table does not know is named by the browser.
    expect(choices.find((c) => c.code === "KH")?.name).toBe("Cambodia");
    // Chosen before, none in the pool right now: still there, with none.
    expect(choices[choices.length - 1]).toEqual({ code: "JP", name: "Japan", count: 0 });
    expect(countryChoices(pool, "us").filter((c) => c.code === "US")).toHaveLength(1);
  });

  it("offers the usual few while the pool's list is not in", () => {
    const choices = countryChoices(null, "");
    expect(choices[0]).toEqual({ code: "", name: "Anywhere", count: null });
    expect(choices.map((c) => c.code)).toContain("GB");
    expect(choices.every((c) => c.count === null)).toBe(true);
  });

  it("finds a country by the start of its name, a word of it, its code, or any part", () => {
    const choices = countryChoices(pool, "");
    const names = (typed: string) => matchCountries(choices, typed).map((c) => c.name);
    expect(names("in")).toEqual(["Indonesia", "India", "Argentina", "China"]);
    expect(names("  States ")).toEqual(["United States"]);
    expect(names("de")).toEqual(["Germany"]);
    // The start of a name before a name that only holds it.
    expect(names("any")).toEqual(["Anywhere", "Germany"]);
    expect(names("")).toHaveLength(choices.length);
    expect(names("atlantis")).toEqual([]);
  });

  it("writes counts the way the menu shows them", () => {
    expect(countWords(1612)).toBe("1,612");
    expect(countWords(7)).toBe("7");
  });

  it("asks the pool once, keeps the list ten minutes, and after a failure waits a minute", async () => {
    let asked = 0;
    let fail = true;
    let changes = 0;
    const stop = onFreeCountries(() => (changes += 1));
    const load = async () => {
      asked += 1;
      if (fail) throw new Error("could not reach the HProxy pool");
      return pool;
    };
    const t0 = Date.now();
    ensureFreeCountries(load, t0);
    ensureFreeCountries(load, t0); // on its way: not asked twice
    await settle();
    expect(asked).toBe(1);
    expect(freeCountriesState()).toMatchObject({ list: null, loading: false, error: "could not reach the HProxy pool" });

    ensureFreeCountries(load, t0 + 30_000);
    expect(asked).toBe(1);
    fail = false;
    ensureFreeCountries(load, t0 + 61_000);
    await settle();
    expect(asked).toBe(2);
    expect(freeCountriesState()).toMatchObject({ list: pool, loading: false, error: null });

    ensureFreeCountries(load, t0 + 120_000);
    expect(asked).toBe(2);
    ensureFreeCountries(load, t0 + FREE_COUNTRIES_KEEP_MS + 5_000);
    await settle();
    expect(asked).toBe(3);
    stop();
    // Loading, failed, loading, loaded, loading, loaded.
    expect(changes).toBe(6);
  });
});
