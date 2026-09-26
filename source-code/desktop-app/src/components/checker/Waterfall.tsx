import type { ProtocolTiming, Timings } from "../../lib/checker";

/* Where the time went, as a bar you can read at a glance.
 *
 * The engine reports phase DURATIONS, not cumulative marks, specifically so
 * this component can lay them end to end without doing arithmetic first. unfx
 * has the same underlying numbers and prints them as a column of raw
 * cumulative values (`lookup 12 / connect 240 / response 512`), which makes the
 * reader subtract in their head to answer the only question they had.
 *
 * The phase order matches the order they happen on the wire, and the colours
 * run light to dark through the brand blue as the connection gets further from
 * home, with one contrasting accent for the part that is the proxy thinking
 * rather than the network moving. That last distinction is the whole point of
 * the chart: `Connect` is distance and `Waiting` is load, and they call for
 * opposite decisions about the same proxy.
 */

const PHASES = [
  { key: "dns", label: "DNS", color: "var(--ink-soft)", hint: "Resolving the proxy's hostname" },
  { key: "connect", label: "Connect", color: "var(--digi-light)", hint: "TCP handshake: this is distance" },
  { key: "handshake", label: "Handshake", color: "var(--digi)", hint: "The proxy deciding whether to let you through" },
  { key: "tls", label: "TLS", color: "var(--digi-deep)", hint: "Encrypted handshake with the far end" },
  { key: "ttfb", label: "Waiting", color: "#2bb8a8", hint: "The proxy thinking, plus its own fetch: this is load" },
  { key: "transfer", label: "Transfer", color: "var(--bar)", hint: "Reading the response body" },
] as const;

type PhaseKey = (typeof PHASES)[number]["key"];

function phases(t: Timings): { key: PhaseKey; ms: number }[] {
  const measured: [PhaseKey, number | null | undefined][] = [
    ["dns", t.dns_ms],
    ["connect", t.connect_ms],
    ["handshake", t.handshake_ms],
    ["tls", t.tls_ms],
    ["ttfb", t.ttfb_ms],
  ];
  const sum = measured.reduce((a, [, v]) => a + (v ?? 0), 0);
  /* Whatever the phases do not account for is body transfer. Deriving it rather
     than measuring it separately means the bar always adds up to the total the
     table shows, so the chart can never contradict the number beside it. */
  const transfer = Math.max(0, t.total_ms - sum);
  const out = measured
    .filter(([, v]) => v != null)
    .map(([key, v]) => ({ key, ms: v as number }));
  if (transfer > 0) out.push({ key: "transfer", ms: transfer });
  return out;
}

const meta = (k: PhaseKey) => PHASES.find((p) => p.key === k)!;

export function Waterfall({ entry }: { entry: ProtocolTiming }) {
  const t = entry.timings;
  const parts = phases(t);
  const total = Math.max(t.total_ms, 1);

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-bold uppercase tracking-[0.12em] text-digi">
          {entry.protocol}
        </span>
        <span className="num text-[13px] font-bold text-ink">{t.total_ms} ms</span>
      </div>

      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-hairline" role="img"
           aria-label={parts.map((p) => `${meta(p.key).label} ${p.ms}ms`).join(", ")}>
        {parts.map((p) => (
          <span
            key={p.key}
            title={`${meta(p.key).label}: ${p.ms}ms — ${meta(p.key).hint}`}
            style={{
              width: `${(p.ms / total) * 100}%`,
              // A 1ms phase is real and must not vanish, but it also must not be
              // allowed to imply it took longer than it did, hence 3px and no more.
              minWidth: p.ms > 0 ? 3 : 0,
              background: meta(p.key).color,
            }}
          />
        ))}
      </div>

      <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1">
        {parts.map((p) => (
          <span key={p.key} className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-mute">
            <span className="h-2 w-2 rounded-full" style={{ background: meta(p.key).color }} />
            {meta(p.key).label}
            <span className="num text-ink">{p.ms}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Every transport that answered, so a proxy that is quick over SOCKS5 and slow
    over HTTP shows both rather than an average of two different things. */
export function Waterfalls({ timings }: { timings?: ProtocolTiming[] }) {
  if (!timings || timings.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {timings.map((t) => (
        <Waterfall key={t.protocol} entry={t} />
      ))}
    </div>
  );
}
