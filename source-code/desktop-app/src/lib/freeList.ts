/* The Free tab's list: the pool's free proxies for one country and protocol,
   each tested from this computer before it gets a Connect button. No React in
   here (the screen is FreePane in components/connect/Destinations.tsx), so
   every rule is a plain function with a test.

   WHY EACH ONE IS TESTED HERE. A proxy on the pool's list is not a proxy that
   works from here: public proxies come and go by the minute, and many that
   answer read HTTPS (they hand out certificates of their own). Every row gets
   the test Connect itself uses (`free_test` in src-tauri/src/connect.rs, the
   relay's own test), a few at a time. Only the ones that pass are listed:
   in the order they passed while tests still run, so a row never moves under
   the pointer, then the fastest first once every test has answered.

   One tested list per country and protocol is kept in memory for a few
   minutes. Leaving the tab and coming back shows it again, and tests still
   running carry on while the tab is closed.

   The country menu offers every country the pool has proxies in, with how
   many (`free_countries`, 119 countries on 2026-09-30), not a fixed few. */

import { FREE_COUNTRIES, freeCountryName } from "./connect";
import { countryName } from "./checker";
import type { FreeCountry, FreeExit, FreeTest } from "./tauri";

/** Tested at once. The relay's own search uses the same number
    (proxy-engine/hproxy-relay/src/pool.rs, SEARCH_PARALLEL). */
export const FREE_TESTS_AT_ONCE = 6;
/** How long a tested list is shown again before a fresh batch is tested. */
export const FREE_LIST_KEEP_MS = 5 * 60_000;

export type FreeRow = {
  exit: FreeExit;
  /** host:port: what a picked free place stores. */
  addr: string;
  state: "waiting" | "testing" | "ok" | "bad";
  /** The test's round trip, when it passed. */
  ms?: number;
  /** Why not, in words, when it failed. */
  why?: string;
  /** 1 for the first to pass, 2 for the next, and so on. */
  passed?: number;
};

export type FreeRun = {
  /** A fresh batch is a new run; answers for a replaced run are dropped. */
  id: number;
  country: string;
  socks5: boolean;
  startedAt: number;
  /** The pool's list is on its way. */
  loading: boolean;
  /** Why the pool could not give its list, in words. */
  error: string | null;
  rows: FreeRow[];
};

/** host:port the way the relay writes it (`Upstream::addr`): an IPv6 address
    in brackets, so the port stays readable. */
export const addrOf = (e: FreeExit): string => (e.host.includes(":") && !e.host.startsWith("[") ? `[${e.host}]:${e.port}` : `${e.host}:${e.port}`);

/** The pool's list as rows, one per address, all waiting for their test. */
export function rowsOf(exits: FreeExit[]): FreeRow[] {
  const seen = new Set<string>();
  const rows: FreeRow[] = [];
  for (const exit of exits) {
    const addr = addrOf(exit);
    if (seen.has(addr)) continue;
    seen.add(addr);
    rows.push({ exit, addr, state: "waiting" });
  }
  return rows;
}

/** The rows with one of them being tested now. */
export function withTesting(rows: FreeRow[], addr: string): FreeRow[] {
  return rows.map((r) => (r.addr === addr ? { ...r, state: "testing" } : r));
}

/** The rows with one test's answer written in. A pass is numbered after the
    passes before it, which is the order the list shows. */
export function withAnswer(rows: FreeRow[], addr: string, answer: FreeTest): FreeRow[] {
  const passedSoFar = rows.filter((r) => r.state === "ok").length;
  return rows.map((r): FreeRow => {
    if (r.addr !== addr) return r;
    if (answer.ok) return { exit: r.exit, addr, state: "ok", ms: answer.ms ?? undefined, passed: passedSoFar + 1 };
    return { exit: r.exit, addr, state: "bad", why: answer.why?.trim() || "did not work" };
  });
}

const byPassed = (a: FreeRow, b: FreeRow) => (a.passed ?? 0) - (b.passed ?? 0);

/** The ones that passed: in the order they passed while tests still run (a
    row that is shown never moves under the pointer), the fastest first once
    every test has answered. */
export function workingRows(rows: FreeRow[]): FreeRow[] {
  const ok = rows.filter((r) => r.state === "ok");
  if (testsLeft(rows) > 0) return ok.sort(byPassed);
  return ok.sort((a, b) => (a.ms ?? Number.MAX_SAFE_INTEGER) - (b.ms ?? Number.MAX_SAFE_INTEGER) || byPassed(a, b));
}

export function failedRows(rows: FreeRow[]): FreeRow[] {
  return rows.filter((r) => r.state === "bad");
}

/** Tests not answered yet: waiting or running. */
export function testsLeft(rows: FreeRow[]): number {
  return rows.filter((r) => r.state === "waiting" || r.state === "testing").length;
}

const proto = (socks5: boolean) => (socks5 ? "SOCKS5" : "HTTP");
const where = (country: string) => (country ? `in ${freeCountryName(country)}` : "from every country");

/** The line above the list: what is happening and how it went. */
export function runWords(run: FreeRun | undefined, country: string, socks5: boolean): string {
  if (!run || run.loading) return `Getting the free ${proto(socks5)} proxies ${where(country)}…`;
  if (run.error) return "The free list could not be loaded";
  const n = run.rows.length;
  if (n === 0) return `The pool has no free ${proto(socks5)} proxy ${where(country)} right now`;
  const ok = run.rows.filter((r) => r.state === "ok").length;
  const left = testsLeft(run.rows);
  if (left > 0) return `Testing ${n} free ${proto(socks5)} proxies ${where(country)}: ${n - left} done, ${ok} working`;
  if (ok === 0) return `None of the ${n} tested works from here right now`;
  return `${ok} of ${n} tested work from here right now`;
}

/** A row's place and network, for its second line. */
export function rowPlace(r: FreeRow): string {
  return [rowWhere(r), r.exit.network].filter(Boolean).join(" · ");
}

/** A row's city and country, as far as the pool knows them. */
export function rowWhere(r: FreeRow): string {
  return [r.exit.city, countryName(r.exit.country || undefined)].filter(Boolean).join(", ");
}

/* ── The country menu ───────────────────────────────────────────────────── */

export type CountryChoice = {
  /** Two-letter code; empty for Anywhere. */
  code: string;
  name: string;
  /** Free proxies of every protocol in the pool; null when not known. */
  count: number | null;
};

/** What the country menu offers: Anywhere first, then the pool's countries
    with the most proxies first. Without the pool's list (not in yet, or it
    could not be loaded) the usual few from FREE_COUNTRIES. The country chosen
    is always there, even when the pool has none in it right now. */
export function countryChoices(pool: FreeCountry[] | null, chosen: string): CountryChoice[] {
  const total = pool ? pool.reduce((n, c) => n + c.count, 0) : null;
  const out: CountryChoice[] = [{ code: "", name: "Anywhere", count: total }];
  const seen = new Set<string>([""]);
  const add = (code: string, count: number | null) => {
    const cc = code.trim().toUpperCase();
    if (seen.has(cc)) return;
    seen.add(cc);
    out.push({ code: cc, name: freeCountryName(cc), count });
  };
  if (pool?.length) for (const c of pool) add(c.code, c.count);
  else for (const [code] of FREE_COUNTRIES) if (code) add(code, null);
  if (chosen) add(chosen, pool ? 0 : null);
  return out;
}

/** The choices that match what was typed, best match first: a code typed in
    full or a name that starts with it, then a word of a name that starts with
    it, then a name that holds it anywhere. The pool's order (the most proxies
    first) inside each. Nothing typed: every choice. */
export function matchCountries(choices: CountryChoice[], typed: string): CountryChoice[] {
  const q = typed.trim().toLowerCase();
  if (!q) return choices;
  const rank = (c: CountryChoice): number => {
    const name = c.name.toLowerCase();
    if (c.code.toLowerCase() === q || name.startsWith(q)) return 0;
    if (name.split(/[\s,.()&-]+/).some((w) => w.startsWith(q))) return 1;
    if (name.includes(q)) return 2;
    return 3;
  };
  return choices
    .map((c, i) => ({ c, i, r: rank(c) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/** How many there are, the way the menu writes it: 1,612. */
export const countWords = (n: number): string => n.toLocaleString("en-US");

/* ── The pool's countries, kept while the app is open ───────────────────── */

/** How long the pool's country list is used before it is asked again. */
export const FREE_COUNTRIES_KEEP_MS = 10 * 60_000;

export type CountriesState = {
  list: FreeCountry[] | null;
  loading: boolean;
  /** Why the list could not be loaded, in words. */
  error: string | null;
  /** When the list (or the error) came in. */
  at: number;
};

let countriesState: CountriesState = { list: null, loading: false, error: null, at: 0 };
const countryListeners = new Set<() => void>();

/** Call `fn` whenever the country list changes. Returns the way to stop. */
export function onFreeCountries(fn: () => void): () => void {
  countryListeners.add(fn);
  return () => void countryListeners.delete(fn);
}

/** The country list as it stands. The same object until it changes. */
export function freeCountriesState(): CountriesState {
  return countriesState;
}

function putCountries(next: CountriesState) {
  countriesState = next;
  for (const fn of countryListeners) fn();
}

/** Ask the pool for its countries, unless a list younger than
    FREE_COUNTRIES_KEEP_MS is kept or one is on its way. A failure keeps the
    list from before, if there is one, and is asked again after a minute. */
export function ensureFreeCountries(load: () => Promise<FreeCountry[]>, now: number = Date.now()): void {
  const s = countriesState;
  if (s.loading) return;
  if (s.list && !s.error && now - s.at < FREE_COUNTRIES_KEEP_MS) return;
  if (s.error && now - s.at < 60_000) return;
  putCountries({ ...s, loading: true });
  load().then(
    (list) => putCountries({ list, loading: false, error: null, at: Date.now() }),
    (e) => putCountries({ ...countriesState, loading: false, error: words(e), at: Date.now() }),
  );
}

/** A sentence from the engine, as a sentence on the screen. */
export const capitalized = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/* ── The runs, kept while the app is open ───────────────────────────────── */

/** What a run asks: the pool's list and one test. The app passes lib/tauri.ts's
    `freeList` and `freeTest`; the tests pass their own. */
export type FreeDeps = {
  list: (country: string | null, socks5: boolean) => Promise<FreeExit[]>;
  test: (host: string, port: number, socks5: boolean) => Promise<FreeTest>;
  now?: () => number;
};

const runs = new Map<string, FreeRun>();
const listeners = new Set<() => void>();
let lastId = 0;

const keyOf = (country: string, socks5: boolean) => `${country.toUpperCase()}|${socks5 ? "socks5" : "http"}`;

/** Call `fn` whenever a run changes. Returns the way to stop. */
export function onFreeRuns(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The run kept for a country and protocol, if there is one. The same object
    until it changes, so a screen can read it on every render. */
export function freeRun(country: string, socks5: boolean): FreeRun | undefined {
  return runs.get(keyOf(country, socks5));
}

function put(run: FreeRun) {
  runs.set(keyOf(run.country, run.socks5), run);
  for (const fn of listeners) fn();
}

/** The run of this country and protocol while it is still run `id`. */
function stillRun(country: string, socks5: boolean, id: number): FreeRun | undefined {
  const r = runs.get(keyOf(country, socks5));
  return r?.id === id ? r : undefined;
}

const words = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A tested list for this country and protocol: the one kept when it is
    younger than FREE_LIST_KEEP_MS, else a new batch from the pool, tested from
    here FREE_TESTS_AT_ONCE at a time. `fresh` asks for a new batch anyway. */
export function ensureFreeRun(country: string, socks5: boolean, deps: FreeDeps, fresh = false): FreeRun {
  const now = (deps.now ?? Date.now)();
  const kept = freeRun(country, socks5);
  if (kept && !fresh && now - kept.startedAt < FREE_LIST_KEEP_MS) return kept;

  const id = ++lastId;
  const run: FreeRun = { id, country, socks5, startedAt: now, loading: true, error: null, rows: [] };
  put(run);
  void (async () => {
    let exits: FreeExit[];
    try {
      exits = await deps.list(country || null, socks5);
    } catch (e) {
      const r = stillRun(country, socks5, id);
      if (r) put({ ...r, loading: false, error: words(e) });
      return;
    }
    const listed = stillRun(country, socks5, id);
    if (!listed) return;
    const rows = rowsOf(exits);
    put({ ...listed, loading: false, rows });

    const queue = [...rows];
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const before = stillRun(country, socks5, id);
        if (!before) return;
        put({ ...before, rows: withTesting(before.rows, row.addr) });
        let answer: FreeTest;
        try {
          answer = await deps.test(row.exit.host, row.exit.port, socks5);
        } catch (e) {
          answer = { ok: false, why: words(e) };
        }
        const after = stillRun(country, socks5, id);
        if (!after) return;
        put({ ...after, rows: withAnswer(after.rows, row.addr, answer) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(FREE_TESTS_AT_ONCE, queue.length) }, worker));
  })();
  return run;
}
