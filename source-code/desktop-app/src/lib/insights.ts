/* What this machine has learned about the networks you keep checking.
 *
 * ## Aggregates, deliberately, not a log
 *
 * The obvious way to answer "is AS-X slower for me than average" is to keep
 * every result and query it later. We do not, for two reasons.
 *
 * The first is honesty about privacy. This app promises that nothing about your
 * proxies leaves the machine, and a stored history of every address you have
 * ever checked would be the single most sensitive artefact the tool produces,
 * sitting in a plaintext file, forever, to power one sentence on a screen.
 * Aggregates cannot be turned back into a list of what you checked.
 *
 * The second is that it is simply better maths. Latency is heavily skewed, so a
 * running mean is dominated by a handful of timeouts and reports numbers no
 * proxy ever produced. A small log-spaced histogram gives real medians and p90s,
 * costs about a hundred bytes per network, and stays that size whether you
 * check a thousand proxies or ten million.
 */

import type { Row } from "./checker";

const KEY = "hproxy-checker-networks";
const VERSION = 3;

/* Log-spaced buckets: 10ms up to roughly 21 seconds in 42 steps of 1.2x.
   A whole latency distribution in 42 small integers, about 120 bytes, and that
   size never grows however much you check.

   The 1.2 factor is load-bearing rather than arbitrary. Because every reported
   median is a bucket midpoint, the only ratios two medians can ever have are
   exact powers of the factor. At 1.4 the smallest possible non-zero difference
   was already 1.4x, so a "1.4x is significant" threshold fired on values one
   bucket apart, which is to say on rounding. At 1.2 the smallest real step is
   1.2x and a two-bucket threshold lands at a defensible 1.44x. */
const BASE_MS = 10;
const FACTOR = 1.2;
export const BUCKETS = 42;

/* The smallest gap worth reporting: two buckets. One bucket apart is
   indistinguishable from where the boundaries happen to fall. */
const NOTICEABLE = FACTOR * FACTOR;

/** Minimum samples before a network is allowed to appear in an insight.
    An observation drawn from four proxies is noise wearing the costume of
    data, and stating it confidently is worse than saying nothing. */
const MIN_SAMPLE = 15;

/** Hard cap on stored networks, least-seen evicted first. Bounds the file
    forever, whatever the user does. */
const MAX_NETWORKS = 2000;

export type NetworkStat = {
  asn: number;
  org: string;
  /** Every proxy on this network we have checked, alive or not. */
  seen: number;
  alive: number;
  /** Latency distribution of the ALIVE ones. A dead proxy has no latency, and
      folding it in as a zero or as the timeout would corrupt both ends. */
  hist: number[];
  lastSeen: number;
};

export type Stats = {
  v: number;
  runs: number;
  networks: Record<string, NetworkStat>;
  /** Cheap "you mostly check X" rollup. Country code to count. */
  countries: Record<string, number>;
};

const empty = (): Stats => ({ v: VERSION, runs: 0, networks: {}, countries: {} });

export function bucketFor(ms: number): number {
  if (!Number.isFinite(ms) || ms <= BASE_MS) return 0;
  const i = Math.floor(Math.log(ms / BASE_MS) / Math.log(FACTOR));
  return Math.min(Math.max(i, 0), BUCKETS - 1);
}

/** Geometric midpoint of a bucket: the representative value for anything
    that landed in it. Geometric rather than arithmetic because the buckets
    themselves are geometric. */
export function bucketMid(i: number): number {
  return Math.round(BASE_MS * Math.pow(FACTOR, i + 0.5));
}

/** Estimate a percentile from a histogram. Null when there is nothing in it. */
export function percentile(hist: number[], p: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const target = total * p;
  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    cum += hist[i];
    if (cum >= target) return bucketMid(i);
  }
  return bucketMid(hist.length - 1);
}

export function loadStats(): Stats {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Stats;
    // A version bump means the shape changed. Starting over loses a little
    // history and is far better than rendering a confident number derived from
    // fields that no longer mean what they used to.
    if (parsed?.v !== VERSION || typeof parsed.networks !== "object") return empty();
    return parsed;
  } catch {
    return empty();
  }
}

export function clearStats(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Fold one finished run into the store. */
export function recordRun(rows: Row[]): Stats {
  const s = loadStats();
  s.runs += 1;

  for (const r of rows) {
    if (r.status === "pending") continue;
    if (r.cc) s.countries[r.cc] = (s.countries[r.cc] ?? 0) + 1;

    // No ASN means nothing to attribute this to. Bucketing those together
    // under "unknown" would invent a network that does not exist and it would
    // usually be the biggest one on the chart.
    const asn = r.asn ? Number(r.asn.replace(/^AS/i, "")) : NaN;
    if (!Number.isFinite(asn)) continue;

    const key = String(asn);
    const n: NetworkStat = s.networks[key] ?? {
      asn,
      org: r.isp ?? `AS${asn}`,
      seen: 0,
      alive: 0,
      hist: new Array(BUCKETS).fill(0),
      lastSeen: 0,
    };
    // Histograms written by an older version may be a different width.
    if (n.hist.length !== BUCKETS) n.hist = new Array(BUCKETS).fill(0);

    n.seen += 1;
    n.lastSeen = Date.now();
    if (r.isp) n.org = r.isp;
    if (r.status === "working") {
      n.alive += 1;
      if (typeof r.latency === "number" && r.latency > 0) n.hist[bucketFor(r.latency)] += 1;
    }
    s.networks[key] = n;
  }

  evict(s);
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* A full quota must never break a check that already succeeded. */
  }
  return s;
}

function evict(s: Stats): void {
  const keys = Object.keys(s.networks);
  if (keys.length <= MAX_NETWORKS) return;
  // Least seen goes first, ties broken by least recent. Frequency is the better
  // signal of what the user actually cares about; recency only settles ties.
  keys
    .sort((a, b) => {
      const x = s.networks[a];
      const y = s.networks[b];
      return x.seen - y.seen || x.lastSeen - y.lastSeen;
    })
    .slice(0, keys.length - MAX_NETWORKS)
    .forEach((k) => delete s.networks[k]);
}

export type Insight = {
  kind: "most-checked" | "slower" | "faster" | "unreliable" | "reliable";
  /** The sentence to show. Written as a plain statement, no exclamation. */
  text: string;
  asn?: number;
  org?: string;
  /** Samples the claim rests on, so the UI can show its working. */
  sample: number;
};

type Scored = NetworkStat & { median: number | null; rate: number };

/** Turn the store into the handful of sentences worth saying.
 *
 * Every claim is gated on `MIN_SAMPLE` and on a difference large enough to
 * survive the histogram's own resolution. The alternative — surfacing whatever
 * happens to be top of a sorted list — produces a confident sentence about
 * three proxies, which is how an analytics feature loses a user's trust the
 * first time they check it against reality.
 */
export function insights(s: Stats): Insight[] {
  const nets: Scored[] = Object.values(s.networks)
    .filter((n) => n.seen >= MIN_SAMPLE)
    .map((n) => ({ ...n, median: percentile(n.hist, 0.5), rate: n.alive / n.seen }));
  if (nets.length === 0) return [];

  const out: Insight[] = [];

  const most = [...nets].sort((a, b) => b.seen - a.seen)[0];
  out.push({
    kind: "most-checked",
    text: `Most of what you check is ${most.org}: ${most.seen} proxies across ${s.runs} ${
      s.runs === 1 ? "run" : "runs"
    }.`,
    asn: most.asn,
    org: most.org,
    sample: most.seen,
  });

  // The comparison baseline is every network pooled, so "slower" means slower
  // than the rest of what this user checks, not slower than some global figure
  // we would have to invent.
  const pooled = new Array(BUCKETS).fill(0);
  for (const n of nets) n.hist.forEach((c, i) => (pooled[i] += c));
  const overall = percentile(pooled, 0.5);

  const timed = nets.filter((n) => n.median !== null && n.alive >= MIN_SAMPLE);
  if (overall !== null && timed.length >= 2) {
    const slowest = [...timed].sort((a, b) => b.median! - a.median!)[0];
    const fastest = [...timed].sort((a, b) => a.median! - b.median!)[0];
    // Two buckets apart, or it is quantization rather than a finding.
    if (slowest.median! >= overall * NOTICEABLE) {
      out.push({
        kind: "slower",
        text: `${slowest.org} runs slower for you than everything else: ${slowest.median}ms typical against ${overall}ms overall.`,
        asn: slowest.asn,
        org: slowest.org,
        sample: slowest.alive,
      });
    }
    if (fastest.median! <= overall / NOTICEABLE && fastest.asn !== slowest.asn) {
      out.push({
        kind: "faster",
        text: `${fastest.org} is your fastest network: ${fastest.median}ms typical against ${overall}ms overall.`,
        asn: fastest.asn,
        org: fastest.org,
        sample: fastest.alive,
      });
    }
  }

  const byRate = [...nets].sort((a, b) => a.rate - b.rate);
  const worst = byRate[0];
  const best = byRate[byRate.length - 1];
  if (worst.rate <= 0.25 && nets.length >= 2) {
    out.push({
      kind: "unreliable",
      text: `${worst.org} rarely works out: ${Math.round(worst.rate * 100)}% of its proxies answered.`,
      asn: worst.asn,
      org: worst.org,
      sample: worst.seen,
    });
  }
  if (best.rate >= 0.7 && best.asn !== worst.asn) {
    out.push({
      kind: "reliable",
      text: `${best.org} is your best bet: ${Math.round(best.rate * 100)}% of its proxies answered.`,
      asn: best.asn,
      org: best.org,
      sample: best.seen,
    });
  }

  return out;
}

/** Networks worth putting in a table, worst hit-rate first. */
export function rankedNetworks(s: Stats): Scored[] {
  return Object.values(s.networks)
    .map((n) => ({ ...n, median: percentile(n.hist, 0.5), rate: n.alive / n.seen }))
    .sort((a, b) => b.seen - a.seen);
}
