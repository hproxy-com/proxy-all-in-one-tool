import { beforeEach, describe, expect, it } from "vitest";
import type { Row } from "./checker";
import {
  BUCKETS,
  bucketFor,
  bucketMid,
  clearStats,
  insights,
  loadStats,
  percentile,
  rankedNetworks,
  recordRun,
} from "./insights";

/* Vitest runs in node, which has no localStorage. A tiny in-memory stand-in
   beats pulling in a whole DOM just to exercise a key-value store. */
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  get length() {
    return this.m.size;
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    new MemStorage() as unknown as Storage;
});

function row(over: Partial<Row> = {}): Row {
  return {
    raw: "1.2.3.4:8080",
    host: "1.2.3.4",
    port: "8080",
    auth: false,
    status: "working",
    ...over,
  };
}

/** n rows on one network, `alive` of them working at `latency`. */
function rows(asn: string, isp: string, total: number, alive: number, latency: number): Row[] {
  return Array.from({ length: total }, (_, i) =>
    row({
      asn,
      isp,
      cc: "de",
      status: i < alive ? "working" : "dead",
      latency: i < alive ? latency : null,
    }),
  );
}

describe("histogram", () => {
  it("buckets monotonically and clamps at both ends", () => {
    expect(bucketFor(1)).toBe(0);
    expect(bucketFor(10)).toBe(0);
    expect(bucketFor(-5)).toBe(0);
    expect(bucketFor(NaN)).toBe(0);
    expect(bucketFor(1_000_000)).toBe(BUCKETS - 1);
    // Strictly non-decreasing across the whole useful range.
    let prev = -1;
    for (const ms of [10, 25, 60, 140, 300, 800, 2000, 6000, 15000]) {
      const b = bucketFor(ms);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });

  it("a value round-trips to within one bucket width", () => {
    for (const ms of [42, 137, 460, 1900]) {
      const mid = bucketMid(bucketFor(ms));
      // Buckets are 1.2x wide, so a midpoint is never more than ~10% out.
      expect(mid).toBeGreaterThan(ms / 1.12);
      expect(mid).toBeLessThan(ms * 1.12);
    }
  });

  it("percentile is null on an empty histogram rather than zero", () => {
    // Zero would render as "0ms typical", which is a measurement nobody made.
    expect(percentile(new Array(BUCKETS).fill(0), 0.5)).toBeNull();
  });

  it("percentile finds the mass", () => {
    const h = new Array(BUCKETS).fill(0);
    h[bucketFor(100)] = 90;
    h[bucketFor(5000)] = 10;
    const p50 = percentile(h, 0.5)!;
    expect(p50).toBeGreaterThan(70);
    expect(p50).toBeLessThan(140);
    // p90 must not be dragged up by the tail the way a mean would be.
    expect(percentile(h, 0.9)!).toBeLessThan(200);
    expect(percentile(h, 0.99)!).toBeGreaterThan(3000);
  });
});

describe("recordRun", () => {
  it("aggregates seen, alive and latency per network", () => {
    recordRun(rows("AS13335", "Cloudflare", 10, 6, 120));
    const s = loadStats();
    const n = s.networks["13335"];
    expect(n.seen).toBe(10);
    expect(n.alive).toBe(6);
    expect(n.org).toBe("Cloudflare");
    expect(n.hist.reduce((a, b) => a + b, 0)).toBe(6);
    expect(s.countries.de).toBe(10);
    expect(s.runs).toBe(1);
  });

  it("accumulates across runs", () => {
    recordRun(rows("AS13335", "Cloudflare", 5, 5, 100));
    recordRun(rows("AS13335", "Cloudflare", 5, 0, 0));
    const n = loadStats().networks["13335"];
    expect(n.seen).toBe(10);
    expect(n.alive).toBe(5);
    expect(loadStats().runs).toBe(2);
  });

  it("ignores rows that are still pending", () => {
    recordRun([row({ asn: "AS1", isp: "X", status: "pending" })]);
    expect(loadStats().networks["1"]).toBeUndefined();
  });

  /* Rows with no ASN would otherwise collect under one invented bucket that is
     usually the biggest thing on the chart, and it represents nothing. */
  it("drops rows with no ASN rather than inventing an 'unknown' network", () => {
    recordRun([row({ isp: "X", status: "working", latency: 50 })]);
    expect(Object.keys(loadStats().networks)).toHaveLength(0);
  });

  it("a dead proxy contributes to seen but never to the latency distribution", () => {
    recordRun(rows("AS7", "Slow Net", 4, 0, 0));
    const n = loadStats().networks["7"];
    expect(n.seen).toBe(4);
    expect(n.alive).toBe(0);
    expect(n.hist.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("clearStats empties the store", () => {
    recordRun(rows("AS1", "A", 20, 20, 100));
    clearStats();
    expect(Object.keys(loadStats().networks)).toHaveLength(0);
  });
});

describe("insights", () => {
  it("says nothing at all from a thin sample", () => {
    // Four proxies is not evidence, and a confident sentence about it is how
    // this feature would lose trust the first time it was checked.
    recordRun(rows("AS1", "Tiny Net", 4, 4, 100));
    expect(insights(loadStats())).toHaveLength(0);
  });

  it("names the network you check most", () => {
    recordRun(rows("AS1", "Big Net", 40, 20, 100));
    recordRun(rows("AS2", "Small Net", 16, 8, 100));
    const out = insights(loadStats());
    const most = out.find((i) => i.kind === "most-checked")!;
    expect(most.org).toBe("Big Net");
    expect(most.sample).toBe(40);
  });

  it("reports a genuinely slower network against the pooled baseline", () => {
    recordRun(rows("AS1", "Fast Net", 40, 40, 80));
    recordRun(rows("AS2", "Slow Net", 40, 40, 900));
    const out = insights(loadStats());
    const slower = out.find((i) => i.kind === "slower");
    expect(slower?.org).toBe("Slow Net");
    expect(slower?.text).toMatch(/slower/);
  });

  /* A gap of one bucket is where the boundaries happen to fall, not a finding.
     This test previously failed against a 1.4x threshold, because at 1.4x
     buckets two adjacent midpoints are exactly 1.4x apart and the threshold
     could only ever be tripped by rounding. That is why the histogram is 1.2x. */
  it("stays quiet when the difference is inside the noise", () => {
    recordRun(rows("AS1", "A", 40, 40, 100));
    recordRun(rows("AS2", "B", 40, 40, 115));
    const out = insights(loadStats());
    expect(out.find((i) => i.kind === "slower")).toBeUndefined();
    expect(out.find((i) => i.kind === "faster")).toBeUndefined();
  });

  /* The other half of that rule: a gap this big is unambiguous and staying
     quiet about it would make the feature useless. */
  it("still speaks up when the difference is real", () => {
    recordRun(rows("AS1", "A", 40, 40, 100));
    recordRun(rows("AS2", "B", 40, 40, 260));
    expect(insights(loadStats()).find((i) => i.kind === "slower")?.org).toBe("B");
  });

  it("calls out an unreliable network and a dependable one", () => {
    recordRun(rows("AS1", "Dud Net", 40, 4, 200));
    recordRun(rows("AS2", "Solid Net", 40, 36, 200));
    const out = insights(loadStats());
    expect(out.find((i) => i.kind === "unreliable")?.org).toBe("Dud Net");
    expect(out.find((i) => i.kind === "reliable")?.org).toBe("Solid Net");
  });

  it("never claims a network is both the worst and the best", () => {
    recordRun(rows("AS1", "Only Net", 40, 4, 200));
    const out = insights(loadStats());
    const kinds = out.map((i) => i.kind);
    expect(kinds.includes("unreliable") && kinds.includes("reliable")).toBe(false);
  });

  it("every claim carries the sample it rests on", () => {
    recordRun(rows("AS1", "A", 40, 40, 80));
    recordRun(rows("AS2", "B", 40, 40, 900));
    for (const i of insights(loadStats())) {
      expect(i.sample).toBeGreaterThanOrEqual(15);
    }
  });
});

describe("rankedNetworks", () => {
  it("orders by how much you have checked them", () => {
    recordRun(rows("AS1", "A", 10, 5, 100));
    recordRun(rows("AS2", "B", 30, 15, 100));
    const ranked = rankedNetworks(loadStats());
    expect(ranked[0].org).toBe("B");
    expect(ranked[0].rate).toBeCloseTo(0.5);
  });
});
