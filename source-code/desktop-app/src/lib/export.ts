/* Turning results into files people can actually use.
 *
 * This was three inline template strings in the console component, and it had
 * two problems worth fixing properly rather than patching.
 *
 * **The CSV was not valid CSV.** Exactly one field was quoted (`isp`), and even
 * that one did not escape embedded quotes. Any country whose name contains a
 * comma — "Korea, Democratic People's Republic of", "Bonaire, Sint Eustatius,
 * Saba", "Congo, The Democratic Republic of The" — shifted every column to its
 * right, for that row only. That is the worst shape a data bug can take: the
 * file opens, most rows are fine, and the broken ones look like real data.
 *
 * **It exported none of what the engine now measures.** No exit address, no
 * timing breakdown, no leaked headers, no software, no indication of which
 * engine produced the row. The whole point of measuring those is that somebody
 * analysing proxies can work with them, and a spreadsheet is where that work
 * actually happens.
 */

import type { ProtocolTiming, Row } from "./checker";

/** RFC 4180: quote when the value contains a comma, a quote, or a newline, and
    double any embedded quote. Everything else goes out bare. */
export function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The fastest transport's timings: the one whose total became the row's
    latency, so the phase columns always describe the number beside them. */
export function fastest(timings?: ProtocolTiming[]): ProtocolTiming | undefined {
  if (!timings || timings.length === 0) return undefined;
  return timings.reduce((a, b) => (b.timings.total_ms < a.timings.total_ms ? b : a));
}

const COLUMNS: [string, (r: Row) => unknown][] = [
  ["proxy", (r) => `${r.host}:${r.port}`],
  ["status", (r) => r.status],
  ["protocols", (r) => (r.protocols ?? []).join("|")],
  ["anonymity", (r) => r.anonymity],
  ["latency_ms", (r) => r.latency],
  ["country_code", (r) => r.cc?.toUpperCase()],
  ["country", (r) => r.country],
  ["city", (r) => r.city],
  ["asn", (r) => r.asn],
  ["isp", (r) => r.isp],
  ["exit_ip", (r) => r.exitIp],
  // Blank rather than "false" when unknown: we could not always observe it, and
  // a column of falses reads as "measured, and no".
  ["rotating", (r) => (r.rotating == null ? "" : r.rotating ? "yes" : "no")],
  ["server", (r) => r.server],
  ["keep_alive", (r) => (r.keepAlive ? "yes" : "")],
  ["leaked_headers", (r) => (r.leaks ?? []).map((h) => `${h.name}=${h.value}`).join("|")],
  // "yes" is a warning: the proxy re-signs HTTPS and can read it. Blank when
  // no HTTPS was relayed or the certificate was the real one.
  ["intercepts_https", (r) => (r.intercepts ? "yes" : "")],
  ["checked_by", (r) => r.source],
  // Phase columns, from the fastest transport.
  ["timed_protocol", (r) => fastest(r.timings)?.protocol],
  ["dns_ms", (r) => fastest(r.timings)?.timings.dns_ms],
  ["connect_ms", (r) => fastest(r.timings)?.timings.connect_ms],
  ["handshake_ms", (r) => fastest(r.timings)?.timings.handshake_ms],
  ["tls_ms", (r) => fastest(r.timings)?.timings.tls_ms],
  ["ttfb_ms", (r) => fastest(r.timings)?.timings.ttfb_ms],
];

export function toCsv(rows: Row[]): string {
  const settled = rows.filter((r) => r.status !== "pending");
  const head = COLUMNS.map(([name]) => name).join(",");
  const body = settled.map((r) => COLUMNS.map(([, get]) => csvCell(get(r))).join(","));
  return [head, ...body].join("\n");
}

export function toJson(rows: Row[]): string {
  const payload = rows
    .filter((r) => r.status !== "pending")
    .map((r) => ({
      proxy: `${r.host}:${r.port}`,
      host: r.host,
      port: Number(r.port),
      status: r.status,
      protocols: r.protocols ?? [],
      anonymity: r.anonymity ?? null,
      latency_ms: r.latency ?? null,
      location: {
        country_code: r.cc?.toUpperCase() ?? null,
        country: r.country ?? null,
        city: r.city ?? null,
      },
      network: { asn: r.asn ?? null, isp: r.isp ?? null },
      exit: { ip: r.exitIp ?? null, rotating: r.rotating ?? null },
      server: r.server ?? null,
      keep_alive: r.keepAlive ?? null,
      leaked_headers: r.leaks ?? [],
      intercepts_https: r.intercepts ?? null,
      // Every transport that answered, not just the fastest. A proxy quick over
      // SOCKS5 and slow over HTTP has two profiles, and flattening them to one
      // throws away the comparison somebody exported the file to make.
      timings: r.timings ?? [],
      checked_by: r.source ?? null,
    }));
  return JSON.stringify(payload, null, 2);
}

/** Plain host:port, one per line. What gets pasted into another tool. */
export function toList(rows: Row[]): string {
  return rows.map((r) => `${r.host}:${r.port}`).join("\n");
}
