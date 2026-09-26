import { describe, expect, it } from "vitest";
import corpus from "../../../engine/hproxy-probe/tests/fixtures/proxy-lines.json";
import { applyCheck, exitsElsewhere, listEntries, parseLines, readList, STATUS_RANK, withGeo, type CheckResult, type Row } from "./checker";

/* The parsing and result-mapping layer, which is where a wrong answer would be
   invisible: nothing throws, the table just quietly says the wrong thing. */

const row = (raw: string): Row => parseLines(raw)[0];

describe("parseLines", () => {
  it("accepts every documented format", () => {
    const rows = parseLines(
      [
        "1.2.3.4:8080",
        "5.6.7.8:3128:user:pass",
        "user:pass@9.10.11.12:1080",
        "socks5://13.14.15.16:1080",
        "http://17.18.19.20:80",
      ].join("\n"),
    );
    expect(rows.map((r) => `${r.host}:${r.port}`)).toEqual([
      "1.2.3.4:8080",
      "5.6.7.8:3128",
      "9.10.11.12:1080",
      "13.14.15.16:1080",
      "17.18.19.20:80",
    ]);
  });

  it("flags the lines that carry a login", () => {
    expect(row("5.6.7.8:3128:user:pass").auth).toBe(true);
    expect(row("user:pass@9.10.11.12:1080").auth).toBe(true);
    expect(row("1.2.3.4:8080").auth).toBe(false);
  });

  it("ignores blank lines and surrounding whitespace", () => {
    const rows = parseLines("\n  1.2.3.4:8080  \n\n\t5.6.7.8:3128\n   \n");
    expect(rows).toHaveLength(2);
    expect(rows[0].host).toBe("1.2.3.4");
  });

  it("starts every row pending", () => {
    expect(row("1.2.3.4:8080").status).toBe("pending");
  });

  /* Duplicates must SURVIVE parsing. The engine deduplicates before checking,
     but the table still has to show every line the user pasted — a row that
     silently disappears reads as data loss. */
  it("keeps duplicate lines as separate rows", () => {
    expect(parseLines("1.2.3.4:8080\n1.2.3.4:8080")).toHaveLength(2);
  });
});

/* The screen counts what the engine will check: the list is read by the
   engine's own parser (chrome-extension/line.js), held to the engine's list of
   shapes, so a line the engine refuses is never counted as a proxy. */
type Case = { line: string; host?: string; port?: number; user?: string; pass?: string; scheme?: string; error?: string; why: string };

describe("readList", () => {
  it("reads every line of the engine's shared list the way the engine does", () => {
    const cases = corpus as Case[];
    expect(cases.length).toBeGreaterThanOrEqual(90);
    for (const c of cases) {
      const read = readList(c.line);
      if (c.error !== undefined) {
        expect(read.rows, `${JSON.stringify(c.line)} (${c.why}) is not a proxy`).toHaveLength(0);
        continue;
      }
      expect(read.rows, `${JSON.stringify(c.line)} (${c.why})`).toHaveLength(1);
      const r = read.rows[0];
      expect(`${r.host}:${r.port}`, c.why).toBe(`${c.host}:${c.port}`);
      expect(r.auth, `${c.why}: login`).toBe(c.user !== undefined);
    }
  });

  it("reads a pasted JSON array, spread over many lines, one proxy per element", () => {
    const pasted = JSON.stringify(
      [
        { ip: "198.51.100.7", port: 8080 },
        { host: "gate.example.com", port: "8000", username: "u", password: "p" },
        "socks5://203.0.113.9:1080",
      ],
      null,
      2,
    );
    expect(listEntries(pasted)).toHaveLength(3);
    expect(readList(pasted).rows.map((r) => `${r.host}:${r.port}`)).toEqual(["198.51.100.7:8080", "gate.example.com:8000", "203.0.113.9:1080"]);
  });

  it("says which lines are not proxies and why, and counts comments and repeats apart", () => {
    const read = readList(["# my list", "198.51.100.7:8080", "ip,port,username,password", "198.51.100.7:8080", "1.2.3.4"].join("\n"));
    expect(read.rows).toHaveLength(2);
    expect(read.comments).toBe(1);
    expect(read.duplicates).toBe(1);
    expect(read.unread.map((u) => u.line)).toEqual(["ip,port,username,password", "1.2.3.4"]);
    expect(read.unread[1].reason).toContain("no port");
  });

  it("sends the engine each proxy as it was written, so results find their rows", () => {
    const read = readList("user:pass@198.51.100.7:8080\n198.51.100.7;3128");
    expect(read.rows.map((r) => r.raw)).toEqual(["user:pass@198.51.100.7:8080", "198.51.100.7;3128"]);
  });
});

describe("applyCheck", () => {
  const base: CheckResult = { input: "1.2.3.4:8080", alive: true, protocols: ["http"] };

  it("maps a live result onto the row", () => {
    const r = applyCheck(row("1.2.3.4:8080"), {
      ...base,
      latency_ms: 120,
      anonymity: "elite",
      country_code: "US",
      country: "United States",
      city: "Dallas",
      asn: 63949,
      asn_org: "Akamai Technologies, Inc.",
    });
    expect(r.status).toBe("working");
    expect(r.latency).toBe(120);
    expect(r.anonymity).toBe("Elite");
    expect(r.cc).toBe("us");
    expect(r.city).toBe("Dallas");
    // asn_org is what fills the ISP column; asn is displayed as "AS…"
    expect(r.isp).toBe("Akamai Technologies, Inc.");
    expect(r.asn).toBe("AS63949");
  });

  it("separates a timeout from a plain dead proxy", () => {
    expect(applyCheck(row("1.2.3.4:8080"), { ...base, alive: false, error: "timeout" }).status).toBe(
      "timeout",
    );
    expect(
      applyCheck(row("1.2.3.4:8080"), { ...base, alive: false, error: "proxy did not respond" })
        .status,
    ).toBe("dead");
  });

  /* The engine reports anonymity lowercase; the UI shows it capitalised and the
     colour lookup keys on the capitalised form. A regression here silently
     turns every anonymity cell into a dash. */
  it("capitalises the anonymity grade the UI keys on", () => {
    for (const [wire, shown] of [
      ["elite", "Elite"],
      ["anonymous", "Anonymous"],
      ["transparent", "Transparent"],
    ] as const) {
      expect(applyCheck(row("1.2.3.4:8080"), { ...base, anonymity: wire }).anonymity).toBe(shown);
    }
  });

  it("leaves geo absent rather than inventing it", () => {
    const r = applyCheck(row("1.2.3.4:8080"), base);
    expect(r.cc).toBeUndefined();
    expect(r.city).toBeUndefined();
    expect(r.isp).toBeUndefined();
  });

  /* The location lookup runs beside the check, so a label can land on a row
     before its result does. A result that carries no location must not wipe it. */
  it("keeps a location that arrived before the result", () => {
    const labelled = withGeo(row("1.2.3.4:8080"), { country_code: "DE", country: "Germany", city: "Berlin", asn: 3320, asn_org: "Deutsche Telekom" });
    const r = applyCheck(labelled, base);
    expect(r.cc).toBe("de");
    expect(r.country).toBe("Germany");
    expect(r.city).toBe("Berlin");
    expect(r.isp).toBe("Deutsche Telekom");
    expect(r.asn).toBe("AS3320");
  });

  /* A rotating gateway: the label that arrived first was the gateway's own
     country. The proxy exits elsewhere, so that label is not this row's. */
  it("drops a gateway's location when the proxy exits elsewhere", () => {
    const labelled = withGeo(row("1.2.3.4:8080"), { country_code: "FR", country: "France", asn_org: "Gateway Host" });
    const r = applyCheck(labelled, { ...base, exit_ip: "203.0.113.9" });
    expect(r.cc).toBeUndefined();
    expect(r.country).toBeUndefined();
    expect(r.isp).toBeUndefined();
    expect(exitsElsewhere(r)).toBe(true);
    // Same address in and out: the early label stands.
    const same = applyCheck(labelled, { ...base, exit_ip: "1.2.3.4" });
    expect(same.cc).toBe("fr");
    expect(exitsElsewhere(same)).toBe(false);
    // A dead row keeps the location of the address that was dialled.
    const dead = applyCheck(labelled, { ...base, alive: false, exit_ip: null });
    expect(dead.cc).toBe("fr");
  });
});

describe("withGeo", () => {
  const base: CheckResult = { input: "1.2.3.4:8080", alive: true, protocols: ["http"] };
  const label = { country_code: "NL", country: "Netherlands", city: "Amsterdam", asn: 14061, asn_org: "DigitalOcean" };

  it("labels a row that settled before its lookup came back", () => {
    const settled = applyCheck(row("1.2.3.4:8080"), base);
    const r = withGeo(settled, label);
    expect(r.cc).toBe("nl");
    expect(r.country).toBe("Netherlands");
    expect(r.city).toBe("Amsterdam");
    expect(r.isp).toBe("DigitalOcean");
    expect(r.asn).toBe("AS14061");
    expect(r.status).toBe(settled.status);
  });

  it("never overwrites what the row already knows", () => {
    const known = applyCheck(row("1.2.3.4:8080"), { ...base, country_code: "US", country: "United States", city: "Dallas", asn: 63949, asn_org: "Akamai" });
    const r = withGeo(known, label);
    expect(r.cc).toBe("us");
    expect(r.city).toBe("Dallas");
    expect(r.isp).toBe("Akamai");
    expect(r.asn).toBe("AS63949");
  });

  it("names the country from its code when the label has no name", () => {
    expect(withGeo(row("1.2.3.4:8080"), { country_code: "FR" }).country).toBe("France");
  });
});

describe("STATUS_RANK", () => {
  /* Working on top, dead at the very bottom: the order the table promises. If
     these drift, the results table silently sorts the wrong way round. */
  it("puts working first and dead last", () => {
    const order = (["dead", "timeout", "pending", "working"] as const)
      .slice()
      .sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b]);
    expect(order).toEqual(["working", "pending", "timeout", "dead"]);
  });
});
