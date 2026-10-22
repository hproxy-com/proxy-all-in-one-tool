/* Fraud scores: how risky the sites a proxy reaches will take its address to
   be. FFraud's free lookup, the person's own API key at other services, or
   several at once, added or changed whenever they like: every service turned
   on answers, the highest score is the one shown, and every answer is named
   beside it.

   The lookups run in the app (src-tauri/src/fraud.rs over
   proxy-engine/hproxy-api/src/fraud.rs), from this computer straight to the service
   picked in Settings, with the person's own key; nothing goes through HProxy.
   This file says which service and with what, keeps what came back for the
   session so no address is asked twice, and gives each score its colour. */

import { fraudLookup, isTauri } from "./tauri";

export type FraudServiceId = "ffraud" | "ipqs" | "scamalytics" | "proxycheck" | "abuseipdb";

/** The keys the person gave, per service, so switching keeps them. */
export type FraudKeys = Partial<Record<Exclude<FraudServiceId, "ffraud">, string>>;

export type FraudService = {
  id: FraudServiceId;
  name: string;
  /** What the key field asks for; none for FFraud. */
  key?: { label: string; placeholder: string; optional?: boolean };
  /** What its number is, in a few words. */
  about: string;
  /** Its website, as Settings shows it and opens it. */
  site: { domain: string; url: string };
  /** What it gives for free, in one line (each read on the service's own page, 2026-10-22). */
  free: string;
  /** Where a free key is made; none for FFraud. */
  getKey?: string;
};

/** In the order Settings shows them, the default first. */
export const FRAUD_SERVICES: readonly FraudService[] = [
  {
    id: "ffraud",
    name: "FFraud",
    about: "Free, no key needed. A score from 0 to 100, a risk word and the reason.",
    site: { domain: "ffraud.com", url: "https://ffraud.com/" },
    free: "Free, no key needed",
  },
  {
    id: "ipqs",
    name: "IPQualityScore",
    key: { label: "API key", placeholder: "Your IPQualityScore API key" },
    about: "Its fraud score, 0 to 100.",
    site: { domain: "ipqualityscore.com", url: "https://www.ipqualityscore.com/" },
    free: "1,000 free lookups a month with a free account",
    getKey: "https://www.ipqualityscore.com/create-account",
  },
  {
    id: "scamalytics",
    name: "Scamalytics",
    key: { label: "API address, or username:key", placeholder: "https://api11.scamalytics.com/v3/you/?key=…" },
    about: "Its score, 0 to 100, and its risk word.",
    site: { domain: "scamalytics.com", url: "https://scamalytics.com/" },
    free: "5,000 free lookups a month with a free key",
    getKey: "https://scamalytics.com/ip/api/pricing",
  },
  {
    id: "proxycheck",
    name: "proxycheck.io",
    key: { label: "API key", placeholder: "Works without one, 100 lookups a day", optional: true },
    about: "Its risk score, 0 to 100.",
    site: { domain: "proxycheck.io", url: "https://proxycheck.io/" },
    free: "100 lookups a day without a key, 1,000 with a free one",
    getKey: "https://proxycheck.io/dashboard/",
  },
  {
    id: "abuseipdb",
    name: "AbuseIPDB",
    key: { label: "API key", placeholder: "Your AbuseIPDB API key" },
    about: "Its abuse confidence, 0 to 100, and how often the address was reported.",
    site: { domain: "abuseipdb.com", url: "https://www.abuseipdb.com/" },
    free: "1,000 free checks a day with a free key",
    getKey: "https://www.abuseipdb.com/register",
  },
];

export const DEFAULT_FRAUD_SERVICE: FraudServiceId = "ffraud";

/** The services turned on, as Settings keeps them: known ids only, each once,
    in the order Settings lists them, and never none (FFraud then). */
export function fraudServicesOf(v: unknown): FraudServiceId[] {
  const on = Array.isArray(v) ? v.filter(isFraudService) : [];
  const ids = FRAUD_SERVICES.map((s) => s.id).filter((id) => on.includes(id));
  return ids.length ? ids : [DEFAULT_FRAUD_SERVICE];
}

export function isFraudService(v: unknown): v is FraudServiceId {
  return typeof v === "string" && FRAUD_SERVICES.some((s) => s.id === v);
}

export function fraudService(id: FraudServiceId): FraudService {
  return FRAUD_SERVICES.find((s) => s.id === id) ?? FRAUD_SERVICES[0];
}

export type FraudScore = {
  ip: string;
  /** 0 to 100; higher is riskier. */
  score: number;
  /** The service's own word, when it gives one. */
  risk: string | null;
  flags: string[];
  reason: string | null;
  service: string;
};

/** One address: its score, or the sentence that says why there is none. */
export type FraudRow = { ip: string; score: FraudScore | null; error: string | null };

/** Every service's answer for one address, in the order Settings lists the services. */
export type FraudSet = { ip: string; answers: { service: FraudServiceId; row: FraudRow }[] };

/** One more answer for an address: replaces that service's last one, keeps the order. */
export function withAnswer(set: FraudSet | undefined, service: FraudServiceId, row: FraudRow): FraudSet {
  const order = (id: FraudServiceId) => FRAUD_SERVICES.findIndex((s) => s.id === id);
  const answers = [...(set?.answers ?? []).filter((a) => a.service !== service), { service, row }];
  answers.sort((a, b) => order(a.service) - order(b.service));
  return { ip: row.ip, answers };
}

/** The answer a screen shows for an address: the highest score any service
    gave, or, when none gave one, the first service's reason. */
export function headline(set: FraudSet): FraudRow {
  let best: FraudRow | null = null;
  for (const { row } of set.answers) {
    if (row.score && (!best?.score || row.score.score > best.score.score)) best = row;
  }
  return best ?? set.answers[0]?.row ?? { ip: set.ip, score: null, error: "No answer" };
}

/** Each service's answer in a few words, for the "i" and the tooltips:
    "IPQualityScore 34 · medium", or the reason it has none. */
export function answerLines(set: FraudSet): string[] {
  return set.answers.map(({ service, row }) => {
    const name = fraudService(service).name;
    return row.score ? `${name} ${fraudLabel(row.score)}` : `${name}: ${row.error ?? "no answer"}`;
  });
}

/** What the app is sent for the picked service (FraudService in hproxy-api). */
export function serviceRequest(id: FraudServiceId, keys: FraudKeys): Record<string, string> {
  switch (id) {
    case "ffraud":
      return { service: "ffraud" };
    case "ipqs":
      return { service: "ipqs", key: (keys.ipqs ?? "").trim() };
    case "scamalytics":
      return { service: "scamalytics", address: (keys.scamalytics ?? "").trim() };
    case "proxycheck": {
      const key = (keys.proxycheck ?? "").trim();
      return key ? { service: "proxycheck", key } : { service: "proxycheck" };
    }
    case "abuseipdb":
      return { service: "abuseipdb", key: (keys.abuseipdb ?? "").trim() };
  }
}

/** Why the picked service cannot be asked yet, or null when it can. */
export function missingKey(id: FraudServiceId, keys: FraudKeys): string | null {
  const s = fraudService(id);
  if (!s.key || s.key.optional) return null;
  const given = (keys[id as keyof FraudKeys] ?? "").trim();
  return given ? null : `${s.name} needs your ${s.key.label.replace(/, or .*/, "")} (Settings, Fraud score)`;
}

/** The colour of a score: our bands, the same for every service. Below 25
    green, 25 to 74 amber, 75 and up red. The number and the service's own
    word always show beside it. */
export function fraudTone(score: number): "ok" | "warn" | "danger" {
  return score >= 75 ? "danger" : score >= 25 ? "warn" : "ok";
}

/** The score in a few words: "12 · low" or "88". */
export function fraudLabel(s: FraudScore): string {
  return s.risk ? `${s.score} · ${s.risk}` : String(s.score);
}

/** Everything else the service said, for a tooltip. */
export function fraudDetail(s: FraudScore): string {
  const parts = [`${s.service}: ${s.score} of 100${s.risk ? `, ${s.risk}` : ""}`];
  if (s.flags.length) parts.push(`Seen as: ${s.flags.join(", ")}`);
  if (s.reason) parts.push(s.reason);
  return parts.join(". ");
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Whether a host is an IP address (v4, or v6 in any written form). */
export function isIpAddress(host: string): boolean {
  const m = IPV4.exec(host);
  if (m) return m.slice(1).every((p) => Number(p) <= 255);
  return host.includes(":") && /^[0-9a-f:.]+$/i.test(host.replace(/^\[|\]$/g, ""));
}

/** The address a checked proxy is scored by: where its traffic came out, or
    its own address when that is an IP. A name with no exit seen has none. */
export function scoredIp(r: { exitIp?: string | null; host: string }): string | undefined {
  if (r.exitIp) return r.exitIp;
  return isIpAddress(r.host) ? r.host.replace(/^\[|\]$/g, "") : undefined;
}

/* ── Looking up, a session's worth ──────────────────────────────────────── */

/** Addresses per call to the app: the column fills in as each batch returns. */
export const LOOKUP_BATCH = 24;

type Lookup = (ips: string[], service: Record<string, string>) => Promise<FraudRow[]>;

/** Scores this session, per service: no address is asked twice. A failed
    lookup is not kept, so fixing a key and asking again works. */
const cache = new Map<string, FraudRow>();

export function cachedScore(id: FraudServiceId, ip: string): FraudRow | undefined {
  return cache.get(`${id}|${ip}`);
}

/** An address every one of these services has scored this session, or undefined. */
export function cachedSet(ids: readonly FraudServiceId[], ip: string): FraudSet | undefined {
  let set: FraudSet | undefined;
  for (const id of ids) {
    const row = cachedScore(id, ip);
    if (!row) return undefined;
    set = withAnswer(set, id, row);
  }
  return set;
}

/** Score these addresses with the picked service, batch by batch; `onBatch`
    gets each batch's rows as they arrive. Resolves to every address's row. */
export async function fraudScores(
  ips: string[],
  id: FraudServiceId,
  keys: FraudKeys,
  onBatch?: (rows: FraudRow[]) => void,
  lookup: Lookup = defaultLookup,
): Promise<Map<string, FraudRow>> {
  const out = new Map<string, FraudRow>();
  const todo: string[] = [];
  for (const ip of new Set(ips.map((i) => i.trim()).filter(Boolean))) {
    const hit = cachedScore(id, ip);
    if (hit) out.set(ip, hit);
    else todo.push(ip);
  }
  if (out.size) onBatch?.([...out.values()]);
  const missing = missingKey(id, keys);
  if (missing) {
    const rows = todo.map((ip) => ({ ip, score: null, error: missing }));
    rows.forEach((r) => out.set(r.ip, r));
    if (rows.length) onBatch?.(rows);
    return out;
  }
  const service = serviceRequest(id, keys);
  for (let i = 0; i < todo.length; i += LOOKUP_BATCH) {
    const batch = todo.slice(i, i + LOOKUP_BATCH);
    let rows: FraudRow[];
    try {
      rows = await lookup(batch, service);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      rows = batch.map((ip) => ({ ip, score: null, error }));
    }
    for (const r of rows) {
      out.set(r.ip, r);
      if (r.score) cache.set(`${id}|${r.ip}`, r);
    }
    onBatch?.(rows);
  }
  return out;
}

/** Score these addresses with every service turned on, side by side; `onBatch`
    gets each service's rows as they arrive. Resolves to every address's set. */
export async function fraudScoresAll(
  ips: string[],
  ids: readonly FraudServiceId[],
  keys: FraudKeys,
  onBatch?: (service: FraudServiceId, rows: FraudRow[]) => void,
  lookup: Lookup = defaultLookup,
): Promise<Map<string, FraudSet>> {
  const each = await Promise.all(ids.map((id) => fraudScores(ips, id, keys, (rows) => onBatch?.(id, rows), lookup).then((m) => [id, m] as const)));
  const out = new Map<string, FraudSet>();
  for (const [id, m] of each) for (const [ip, row] of m) out.set(ip, withAnswer(out.get(ip), id, row));
  return out;
}

/** In the app, the real lookup; in the browser preview, a pretend score that
    says it is one (the preview's relay is pretend too). */
const defaultLookup: Lookup = (ips, service) => (isTauri() ? fraudLookup(ips, service) : pretendLookup(ips, service));

async function pretendLookup(ips: string[], service: Record<string, string>): Promise<FraudRow[]> {
  await new Promise((r) => setTimeout(r, 350));
  const id = isFraudService(service.service) ? service.service : DEFAULT_FRAUD_SERVICE;
  const name = fraudService(id).name;
  return ips.map((ip) => {
    const n = [...`${id}${ip}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7);
    const score = n % 100 < 70 ? n % 24 : n % 100;
    const risk = score >= 75 ? "high" : score >= 25 ? "medium" : "low";
    return {
      ip,
      score: { ip, score, risk, flags: ["hosting"], reason: `Browser preview: a pretend score. The app asks ${name} for real.`, service: name },
      error: null,
    };
  });
}

/** An address anyone may look up, for the Settings test (Cloudflare's resolver). */
export const TEST_IP = "1.1.1.1";

/** Ask the picked service once, past the session's scores, so a new key is
    really tried. Resolves to the sentence the Settings test shows. */
export async function testFraudService(
  id: FraudServiceId,
  keys: FraudKeys,
  lookup: Lookup = defaultLookup,
): Promise<{ ok: boolean; text: string }> {
  const missing = missingKey(id, keys);
  if (missing) return { ok: false, text: missing };
  try {
    const [row] = await lookup([TEST_IP], serviceRequest(id, keys));
    if (row?.score) return { ok: true, text: `It works: ${TEST_IP} scores ${fraudLabel(row.score)} at ${row.score.service}.` };
    return { ok: false, text: row?.error ?? "No answer." };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
}

/** Forget this session's scores (for tests). */
export function clearFraudCache(): void {
  cache.clear();
}
