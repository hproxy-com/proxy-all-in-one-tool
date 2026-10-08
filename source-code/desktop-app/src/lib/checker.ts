/* The row model, ported from the HProxy website's CheckerConsole: what a row
   is, reading a pasted list with the engine's parser, and folding an engine
   result onto a row. The browser-only simulation lives in preview.ts. */

// The one proxy-line parser in JavaScript, shared with the extension (see
// chrome-extension/line.d.ts): one file, held to the engine's list of shapes.
import { parseLine } from "../../../chrome-extension/line.js";

export type Status = "pending" | "working" | "dead" | "timeout";

/** Where the time went inside one probe. Mirrors the Rust `Timings`.

   Every field is a PHASE DURATION, never a running total, so they can be laid
   end to end as a waterfall without any subtraction. `total_ms` is the whole
   probe, and the gap between it and the sum of the phases is body transfer,
   exactly as a browser's network panel shows it.

   `dns_ms` is null when the proxy was pasted as a literal address (no lookup
   happened at all, which is different from one that took no time), and
   `handshake_ms` is null for plain HTTP, which has no admission step. */
export type Timings = {
  dns_ms?: number | null;
  connect_ms: number;
  handshake_ms?: number | null;
  tls_ms?: number | null;
  ttfb_ms: number;
  total_ms: number;
};

/** Timings tagged with the transport that produced them. A proxy answering on
    two transports has two genuinely different profiles. */
export type ProtocolTiming = { protocol: string; timings: Timings };

/** A header the proxy added on your behalf. The value is the diagnosis: `via`
    means it announced itself, `x-forwarded-for` carrying your own address means
    it announced you. */
export type LeakedHeader = { name: string; value: string };

/** A row in the UI: the pasted line plus whatever the engine has learned. */
export type Row = {
  raw: string;
  host: string;
  port: string;
  auth: boolean;
  status: Status;
  protocols?: string[];
  protocol?: string;
  anonymity?: "Elite" | "Anonymous" | "Transparent";
  cc?: string;
  country?: string;
  city?: string;
  isp?: string;
  asn?: string;
  latency?: number | null;
  /** The address the far end actually saw. */
  exitIp?: string;
  /** Traffic left by a different door than it entered: a rotating gateway, a
      pool, or an onward chain. Undefined means unknown, not no. */
  rotating?: boolean;
  /** One entry per transport that answered. */
  timings?: ProtocolTiming[];
  /** Proxy software, from `Via` / `X-Cache` / `Proxy-Agent`. */
  server?: string;
  /** The evidence behind the anonymity grade. */
  leaks?: LeakedHeader[];
  /** Provable true, never provably false: every request we send asks the proxy
      to close, so a close tells us nothing about whether it could have stayed. */
  keepAlive?: boolean;
  /** Relayed HTTPS with a certificate that was not the real one: it can read what passes. */
  intercepts?: boolean;
  /** Which engine produced this row. API rows carry no timings, exit address,
      leaked headers or software, so without this a mixed run looks arbitrarily
      inconsistent. */
  source?: "local" | "api";
  /** One plain sentence saying why a proxy is not working: "connection refused
      in 38 ms: nothing is listening on that port", "the proxy wants a username
      and password (407)", "answered 200, but it is not a proxy". A dead row
      without a reason is a guess. */
  reason?: string;
  /** The wire word for the same thing, for filters: refused, timeout,
      auth_required, forbidden, bad_status, tls_error, transport_error, no_echo,
      unresolved. */
  failure?: string;
  /** Which judge answered: "echo" (full headers, exact grade) or "trace"
      (Cloudflare's reflector; exit known, grade capped at anonymous). */
  judge?: string;
  /** Whether the proxy relays UDP. Only known when the run asked. */
  udp?: boolean;
  /** Download throughput in Mbit/s. Only known when the run asked. */
  speedMbps?: number;
};

/** The engine's result — snake_case, matching the Rust `CheckResult` serialize
    in the `hproxy-probe` crate. The same row the CLI prints as JSON. */
export type CheckResult = {
  input: string;
  /** alive | dead | invalid | unresolved | unchecked. `alive` keeps its plain
      meaning; this says which kind of "not alive" it was. */
  status?: string | null;
  ip?: string | null;
  port?: number | null;
  alive: boolean;
  protocols?: string[] | null;
  anonymity?: string | null;
  latency_ms?: number | null;
  supports_udp?: boolean | null;
  speed_mbps?: number | null;
  country_code?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  asn?: number | null;
  asn_org?: string | null;
  is_datacenter?: boolean | null;
  error?: string | null;
  failure?: string | null;
  exit_ip?: string | null;
  rotating?: boolean | null;
  timings?: ProtocolTiming[] | null;
  server?: string | null;
  leaked_headers?: LeakedHeader[] | null;
  keep_alive?: boolean | null;
  tls_intercepted?: boolean | null;
  judge?: string | null;
  source?: string | null;
};

export const SAMPLE = `203.0.113.20:8080
198.51.100.44:3128:user:pass
192.0.2.8:1080
203.0.113.5:8888
198.51.100.9:80
192.0.2.117:443
203.0.113.15:30588
198.51.100.133:8811
192.0.2.83:3128
203.0.113.17:1080`;

/** Working first, dead last: the order the table promises (top = working). */
export const STATUS_RANK: Record<Status, number> = { working: 0, pending: 1, timeout: 2, dead: 3 };

const COUNTRY_NAMES: Record<string, string> = {
  us: "United States", de: "Germany", nl: "Netherlands", gb: "United Kingdom",
  fr: "France", sg: "Singapore", jp: "Japan", br: "Brazil", in: "India",
  ca: "Canada", ru: "Russia", cn: "China", es: "Spain", it: "Italy",
  pl: "Poland", ua: "Ukraine", tr: "Turkey", id: "Indonesia", mx: "Mexico",
  au: "Australia", se: "Sweden", ch: "Switzerland", hk: "Hong Kong",
  kr: "South Korea", za: "South Africa", ar: "Argentina", th: "Thailand",
  vn: "Vietnam", ro: "Romania", cz: "Czechia", fi: "Finland", no: "Norway",
  ie: "Ireland", at: "Austria", be: "Belgium", pt: "Portugal", dk: "Denmark",
};

export function countryName(cc?: string): string | undefined {
  if (!cc) return undefined;
  return COUNTRY_NAMES[cc.toLowerCase()] ?? cc.toUpperCase();
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** A pasted list as the entries it holds: one per line, or, when the whole
    paste is a JSON array (a provider's export, often spread over many lines),
    one per element. An element that is an object is passed on as one line of
    JSON, which the parser reads by its keys. */
export function listEntries(text: string): string[] {
  const t = text.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    try {
      const a: unknown = JSON.parse(t);
      if (Array.isArray(a)) {
        return a
          .map((e) => (typeof e === "string" ? e.trim() : e && typeof e === "object" ? JSON.stringify(e) : ""))
          .filter(Boolean);
      }
    } catch {
      /* not JSON after all: read it line by line */
    }
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** What a pasted list holds, read by the same parser as the engine
    (chrome-extension/line.js, held to the engine's own list of shapes in
    proxy-engine/hproxy-probe/tests/fixtures/proxy-lines.json): the proxies to
    check, the lines that are not proxies with the reason, the comments, and
    how many proxies were pasted more than once. Duplicates stay rows: the
    engine checks each proxy once, and a pasted line that silently vanished
    from the table would read as lost. */
export type ReadList = {
  rows: Row[];
  unread: { line: string; reason: string }[];
  comments: number;
  duplicates: number;
};

export function readList(text: string): ReadList {
  const rows: Row[] = [];
  const unread: ReadList["unread"] = [];
  const seen = new Set<string>();
  let comments = 0;
  let duplicates = 0;
  for (const raw of listEntries(text)) {
    const p = parseLine(raw);
    if ("error" in p) {
      if (p.error.startsWith("a comment")) comments++;
      else unread.push({ line: raw, reason: p.error });
      continue;
    }
    const key = `${p.host.toLowerCase()}\n${p.port}\n${p.username}\n${p.password}`;
    if (seen.has(key)) duplicates++;
    seen.add(key);
    rows.push({ raw, host: p.host, port: String(p.port), auth: !!(p.username || p.password), status: "pending" });
  }
  return { rows, unread, comments, duplicates };
}

/** The rows of a pasted list (the live count and the run list). */
export function parseLines(text: string): Row[] {
  return readList(text).rows;
}

/** The location fields of a label or a result, as the row holds them. */
type GeoFields = {
  country_code?: string | null;
  country?: string | null;
  city?: string | null;
  asn?: number | null;
  asn_org?: string | null;
};

/** Fold a location label onto a row. The lookup runs beside the check, so a
    label can arrive before or after the row's result. It only ever fills what
    the row does not know yet: a label never overwrites, whichever came first. */
export function withGeo(row: Row, g: GeoFields): Row {
  const cc = g.country_code ? g.country_code.toLowerCase() : undefined;
  return {
    ...row,
    cc: row.cc ?? cc,
    country: row.country ?? g.country ?? countryName(row.cc ?? cc),
    city: row.city ?? g.city ?? undefined,
    isp: row.isp ?? g.asn_org ?? undefined,
    asn: row.asn ?? (g.asn != null ? `AS${g.asn}` : undefined),
  };
}

/** A working row whose traffic leaves by another address than the one that was
    dialled: a rotating gateway or a chain. Its location is its exit's, and a
    label for the dialled address describes the gateway, not this row. */
export function exitsElsewhere(row: Row): boolean {
  return row.status === "working" && !!row.exitIp && row.exitIp !== row.host;
}

/** Fold one engine result onto its input row. */
export function applyCheck(row: Row, r: CheckResult): Row {
  // The failure word decides "timeout" versus "dead"; the sentence is for people.
  // Older API rows carry no word, so the sentence is read as a fallback.
  const timedOut = r.failure ? r.failure === "timeout" : !!(r.error && /time(d)? out|timeout/i.test(r.error));
  const status: Status = r.alive ? "working" : timedOut ? "timeout" : "dead";
  const cc = r.country_code ? r.country_code.toLowerCase() : undefined;
  const anon = r.anonymity ? (cap(r.anonymity) as Row["anonymity"]) : undefined;
  /* A label that reached the row before its result was looked up for the
     dialled address. When the proxy turns out to exit elsewhere, that label is
     the gateway's country and is dropped; the exit's own label follows. */
  const exitElsewhere = r.alive && !!r.exit_ip && r.exit_ip !== row.host;
  const keep = <T,>(v: T | undefined): T | undefined => (exitElsewhere ? undefined : v);
  return {
    ...row,
    status,
    reason: r.alive ? undefined : (r.error ?? undefined),
    failure: r.failure ?? undefined,
    judge: r.judge ?? undefined,
    udp: r.supports_udp ?? undefined,
    speedMbps: r.speed_mbps ?? undefined,
    protocols: r.protocols ?? undefined,
    protocol: r.protocols?.[0]?.toUpperCase() ?? row.protocol,
    anonymity: anon,
    // What the result knows wins; what it does not know keeps whatever a
    // location label already put on the row (see `withGeo`), unless that label
    // described a gateway the traffic does not leave by.
    cc: cc ?? keep(row.cc),
    country: r.country ?? countryName(cc) ?? keep(row.country),
    city: r.city ?? keep(row.city),
    isp: r.asn_org ?? keep(row.isp),
    asn: r.asn != null ? `AS${r.asn}` : keep(row.asn),
    latency: r.latency_ms ?? null,
    exitIp: r.exit_ip ?? undefined,
    rotating: r.rotating ?? undefined,
    timings: r.timings ?? undefined,
    server: r.server ?? undefined,
    // Empty means "nothing leaked", which is a fact worth distinguishing from
    // "we never looked" — but for rendering, absent and empty are the same, and
    // collapsing here keeps every consumer from having to check both.
    leaks: r.leaked_headers?.length ? r.leaked_headers : undefined,
    keepAlive: r.keep_alive ?? undefined,
    intercepts: r.tls_intercepted ?? undefined,
    source: r.source === "api" ? "api" : "local",
  };
}
