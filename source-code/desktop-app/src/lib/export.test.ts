import { describe, expect, it } from "vitest";
import type { Row } from "./checker";
import { csvCell, fastest, toCsv, toJson, toList } from "./export";

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

describe("csvCell", () => {
  /* The bug this file exists for. A country like "Korea, Democratic People's
     Republic of" used to shift every column to its right, for that row only,
     which is the worst shape a data bug can take: the file opens and the broken
     rows look like real data. */
  it("quotes a value containing a comma", () => {
    expect(csvCell("Korea, Democratic People's Republic of")).toBe(
      '"Korea, Democratic People\'s Republic of"',
    );
  });

  it("doubles embedded quotes rather than emitting them raw", () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("quotes newlines, which would otherwise end the record", () => {
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
  });

  it("leaves ordinary values bare", () => {
    expect(csvCell("Germany")).toBe("Germany");
    expect(csvCell(220)).toBe("220");
  });

  it("renders null and undefined as empty, not as the words", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("fastest", () => {
  it("picks the transport whose total became the row's latency", () => {
    const t = fastest([
      { protocol: "http", timings: { connect_ms: 10, ttfb_ms: 300, total_ms: 310 } },
      { protocol: "socks5", timings: { connect_ms: 10, ttfb_ms: 80, total_ms: 90 } },
    ]);
    expect(t?.protocol).toBe("socks5");
  });

  it("is undefined when nothing answered", () => {
    expect(fastest([])).toBeUndefined();
    expect(fastest(undefined)).toBeUndefined();
  });
});

describe("toCsv", () => {
  it("emits a header and one line per settled row", () => {
    const csv = toCsv([row(), row({ host: "5.6.7.8" }), row({ status: "pending" })]);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("proxy,status,protocols");
    expect(lines).toHaveLength(3); // header + two settled rows
  });

  it("carries the analyst columns the engine now measures", () => {
    const csv = toCsv([
      row({
        exitIp: "9.9.9.9",
        rotating: true,
        server: "Squid",
        keepAlive: true,
        source: "local",
        leaks: [{ name: "via", value: "1.1 squid" }],
        timings: [
          {
            protocol: "http",
            timings: { dns_ms: null, connect_ms: 40, handshake_ms: null, tls_ms: null, ttfb_ms: 180, total_ms: 225 },
          },
        ],
      }),
    ]);
    const head = csv.split("\n")[0];
    for (const col of ["exit_ip", "rotating", "server", "connect_ms", "ttfb_ms", "checked_by"]) {
      expect(head).toContain(col);
    }
    const line = csv.split("\n")[1];
    expect(line).toContain("9.9.9.9");
    expect(line).toContain("Squid");
    expect(line).toContain("via=1.1 squid");
    expect(line).toContain("40");
  });

  /* An unobserved value must be blank, not "no". A column of falses reads as
     "we measured this and the answer was no", which is a different claim. */
  it("leaves rotating blank when it could not be observed", () => {
    const csv = toCsv([row({ rotating: undefined })]);
    const cols = csv.split("\n")[1].split(",");
    const idx = csv.split("\n")[0].split(",").indexOf("rotating");
    expect(cols[idx]).toBe("");
  });

  it("a comma in a country cannot shift the columns", () => {
    const csv = toCsv([row({ country: "Congo, The Democratic Republic of The", city: "Kinshasa" })]);
    const line = csv.split("\n")[1];
    // Quoted as one field, so the city still lands in the city column.
    expect(line).toContain('"Congo, The Democratic Republic of The",Kinshasa');
  });
});

describe("toJson", () => {
  it("nests location, network and exit, and keeps every transport's timings", () => {
    const out = JSON.parse(
      toJson([
        row({
          cc: "de",
          country: "Germany",
          city: "Berlin",
          asn: "AS24940",
          isp: "Hetzner",
          exitIp: "9.9.9.9",
          rotating: false,
          timings: [
            { protocol: "http", timings: { connect_ms: 10, ttfb_ms: 300, total_ms: 310 } },
            { protocol: "socks5", timings: { connect_ms: 10, ttfb_ms: 80, total_ms: 90 } },
          ],
        }),
      ]),
    );
    expect(out[0].location).toEqual({ country_code: "DE", country: "Germany", city: "Berlin" });
    expect(out[0].network).toEqual({ asn: "AS24940", isp: "Hetzner" });
    expect(out[0].exit).toEqual({ ip: "9.9.9.9", rotating: false });
    expect(out[0].timings).toHaveLength(2);
    expect(out[0].port).toBe(8080);
  });

  it("drops rows that never settled", () => {
    expect(JSON.parse(toJson([row({ status: "pending" })]))).toHaveLength(0);
  });
});

describe("toList", () => {
  it("is plain host:port, one per line", () => {
    expect(toList([row(), row({ host: "5.6.7.8", port: "1080" })])).toBe("1.2.3.4:8080\n5.6.7.8:1080");
  });
});
