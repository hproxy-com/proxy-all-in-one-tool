import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Row, Timings } from "../../lib/checker";
import { scoredIp, type FraudRow } from "../../lib/fraud";
import { thisDevice } from "../../lib/tauri";
import { FraudCell, FraudFact } from "../FraudScore";
import { Button, Icon, Tag, cx } from "../ui";
import { Waterfalls } from "./Waterfall";

/* The result list, in look D (2026-09-23): a filled panel, one grid row per
   proxy, and colour only where there is a judgement. A 4 px bar at the start
   of the row says how it went (green works, amber gives you away or timed
   out, red dead), the anonymity grade is the one coloured word, and a thin
   timing line under the latency says where the time went. unfx's numbered
   circles, tinted rows and flag in a dashed ring are gone.

   Two things carried over from the pass before, because they are ours:

   • The rows are VIRTUALISED against the page's scroll container. A serious
     list is 10 000+ proxies and during a run the parent re-renders every 80 ms,
     so only what is on screen (plus an overscan) is ever in the DOM. The page
     scrolls as one; the header pins under the search row (--stick).

   • The detail is a sheet pinned to the bottom of the window instead of an
     inline expanding row: virtualisation needs every row the same height, and a
     sheet keeps the detail in one place while the rows keep moving. */

/** Fixed row height, in px. The virtualisation maths depends on it. */
const ROW_H = 54;
const OVERSCAN = 10;

type SortKey = "proxy" | "protocol" | "anonymity" | "location" | "keepalive" | "server" | "fraud" | "latency";
type SortDir = "asc" | "desc";

/* The grid's tracks live in globals.css (.ux-head, .ux-row), with the
   narrower layouts; `data-col` is how those layouts drop a column. */
const COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "proxy", label: "Proxy" },
  { key: "protocol", label: "Protocol" },
  { key: "anonymity", label: "Anonymity" },
  { key: "location", label: "Country" },
  { key: "keepalive", label: "Keep-alive" },
  { key: "server", label: "Server" },
  { key: "latency", label: "Latency", align: "right" },
];

/** Once fraud scores are asked for, a column for them before the latency
    (`.ux-table.has-fraud` in globals.css gives it its track). */
const FRAUD_COLUMN: { key: SortKey; label: string; align?: "right" } = { key: "fraud", label: "Fraud", align: "right" };
const COLUMNS_WITH_FRAUD = [...COLUMNS.slice(0, -1), FRAUD_COLUMN, COLUMNS[COLUMNS.length - 1]];

function protoList(r: Row): string[] {
  return r.protocols && r.protocols.length ? r.protocols : r.protocol ? [r.protocol.toLowerCase()] : [];
}

/* The row's protocol chips: one per family, so never more than two. The
   protocol column is 96 px, one chip per line, and a row is ROW_H high; four
   chips (HTTP, HTTPS, SOCKS4, SOCKS5) stood 92 px tall and ran into the next
   row (his screenshot, 2026-09-24). HTTP and HTTPS together read "HTTP/S",
   SOCKS4 and SOCKS5 "SOCKS4/5"; the chip's tooltip and the sheet list each one. */
function protoChips(ps: string[]): { label: string; title: string }[] {
  const family = (a: string, b: string, both: string) => {
    const hasA = ps.includes(a);
    const hasB = ps.includes(b);
    if (hasA && hasB) return [{ label: both, title: `${a.toUpperCase()} and ${b.toUpperCase()}` }];
    if (hasA || hasB) {
      const one = (hasA ? a : b).toUpperCase();
      return [{ label: one, title: one }];
    }
    return [];
  };
  return [...family("http", "https", "HTTP/S"), ...family("socks4", "socks5", "SOCKS4/5")];
}

/** The bar's colour. Anonymous still works and hides you, so it is green like
    Elite; Transparent works but hands your address on, so it is amber. */
function barTone(r: Row): string | undefined {
  if (r.status === "dead") return "tone-danger";
  if (r.status === "timeout") return "tone-warn";
  if (r.status === "pending") return undefined;
  return r.anonymity === "Transparent" ? "tone-warn" : "tone-ok";
}

const GRADE_TEXT: Record<string, string> = {
  Elite: "text-ok",
  Anonymous: "text-accent-ink",
  Transparent: "text-warn",
};

/* The engine's failure word, said in two or three words for the row. The
   whole sentence is on the row's tooltip and in the sheet. */
const FAILURE_SHORT: Record<string, string> = {
  refused: "Refused",
  timeout: "No answer",
  auth_required: "Wants a login",
  forbidden: "Forbidden",
  bad_status: "Bad answer",
  tls_error: "TLS failed",
  transport_error: "Connection lost",
  no_echo: "Not a proxy",
  unresolved: "Unknown host",
};

function failureShort(r: Row): string {
  return (r.failure && FAILURE_SHORT[r.failure]) || (r.status === "timeout" ? "No answer" : "Dead");
}

const ANON_RANK: Record<string, number> = { Elite: 0, Anonymous: 1, Transparent: 2 };

function sortValue(r: Row, key: SortKey, fraud?: Map<string, FraudRow>): string | number {
  switch (key) {
    case "fraud": {
      // Unscored rows sink in both directions, like unknown latency.
      const ip = scoredIp(r);
      return (ip && fraud?.get(ip)?.score?.score) ?? Number.MAX_SAFE_INTEGER;
    }
    case "proxy":
      // Numeric-aware so 10.x sorts after 9.x rather than lexically before it.
      return `${r.host
        .split(".")
        .map((p) => p.padStart(3, "0"))
        .join(".")}:${r.port.padStart(5, "0")}`;
    case "protocol":
      return protoList(r).join(",");
    case "anonymity":
      return r.anonymity ? (ANON_RANK[r.anonymity] ?? 8) : 9;
    case "location":
      // U+FFFF sorts after every real name, so unknown rows sink ascending.
      return `${r.country ?? "￿"}${r.city ?? ""}`;
    case "keepalive":
      return r.keepAlive ? 0 : 1;
    case "server":
      return r.server ?? "￿";
    case "latency":
      // Unknown latency sorts last in BOTH directions, so "fastest first" never
      // opens with a wall of dead proxies.
      return r.latency ?? Number.MAX_SAFE_INTEGER;
  }
}

const spaced = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

/** The three parts of the timing line, from the first transport that answered:
    reaching the proxy, the handshakes on the way in, waiting for the answer. */
function timingParts(t: Timings): { connect: number; shake: number; wait: number } {
  return {
    connect: (t.dns_ms ?? 0) + t.connect_ms,
    shake: (t.handshake_ms ?? 0) + (t.tls_ms ?? 0),
    wait: Math.max(0, t.total_ms - (t.dns_ms ?? 0) - t.connect_ms - (t.handshake_ms ?? 0) - (t.tls_ms ?? 0)),
  };
}

function TimingLine({ timings }: { timings: Timings }) {
  const p = timingParts(timings);
  const total = Math.max(1, p.connect + p.shake + p.wait);
  // 72 px is the whole line; a phase that happened keeps at least 4 px.
  const w = (ms: number) => ({ width: `${Math.max(4, Math.round((ms / total) * 72))}px` });
  return (
    <div className="ux-wf" aria-hidden="true">
      <span className="connect" style={w(p.connect)} />
      {p.shake > 0 && <span className="shake" style={w(p.shake)} />}
      <span className="wait" style={w(p.wait)} />
    </div>
  );
}

export default function ResultsTable({
  rows,
  visible,
  checking,
  scrollRef,
  end,
  onCopyRow,
  onConnectRow,
  fraud,
  onFraud,
}: {
  rows: Row[];
  visible: Row[];
  checking: boolean;
  /** The page's scroll container: the list virtualises against it. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The table's last line: where the other rows went. */
  end?: ReactNode;
  onCopyRow?: (r: Row) => void;
  /** Hand a working proxy to the Connect screen, login included. */
  onConnectRow?: (r: Row) => void;
  /** Fraud scores asked for so far, by address (lib/fraud.ts scoredIp). */
  fraud?: Map<string, FraudRow>;
  /** Ask for the fraud scores of these addresses. */
  onFraud?: (ips: string[]) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);
  const [copied, setCopied] = useState(false);

  /* O(1) row → index. `rows.indexOf(r)` inside the render loop is O(n²). */
  const rowIndex = useMemo(() => {
    const m = new Map<Row, number>();
    rows.forEach((r, i) => m.set(r, i));
    return m;
  }, [rows]);

  /* The parent hands rows in its own order (working first). A user sort
     overrides that; without one the parent's order stands. */
  const ordered = useMemo(() => {
    if (!sort) return visible;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...visible].sort((a, b) => {
      const av = sortValue(a, sort.key, fraud);
      const bv = sortValue(b, sort.key, fraud);
      if (av === bv) return 0;
      return av < bv ? -dir : dir;
    });
  }, [visible, sort, fraud]);

  const hasFraud = !!fraud && fraud.size > 0;
  const columns = hasFraud ? COLUMNS_WITH_FRAUD : COLUMNS;

  /* ── Virtualisation against the page's scroll container ─────────────── */
  const listRef = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ top: 0, height: 600 });

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return;
    const measure = () => {
      // Where the list starts inside the scrolled content, whatever sits above it.
      const listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      setWin({ top: Math.max(0, scroller.scrollTop - listTop), height: scroller.clientHeight });
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    ro.observe(list.parentElement ?? list);
    return () => {
      scroller.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [scrollRef]);

  const total = ordered.length;
  const first = Math.max(0, Math.floor(win.top / ROW_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((win.top + win.height) / ROW_H) + OVERSCAN);
  const slice = ordered.slice(first, last);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));

  const selectedRow = selected != null ? rows[selected] : undefined;

  const copySelected = () => {
    if (!selectedRow || !onCopyRow) return;
    onCopyRow(selectedRow);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={cx("ux-table", hasFraud && "has-fraud")}>
      {/* Pins under the search row once the filters have scrolled away. */}
      <div className="ux-head">
        <span />
        {columns.map((c) => {
          const active = sort?.key === c.key;
          return (
            <span key={c.key} data-col={c.key} className={cx("flex min-w-0 whitespace-nowrap", c.align === "right" && "justify-end")}>
              <button type="button" onClick={() => toggleSort(c.key)} title={`Sort by ${c.label.toLowerCase()}`} className={cx(active && "is-active")}>
                {c.label}
                <Icon.chevronDown className={cx("h-3 w-3", active && sort?.dir === "asc" && "rotate-180")} />
              </button>
            </span>
          );
        })}
      </div>

      <div ref={listRef} style={{ height: total * ROW_H }} className="relative">
        <div style={{ transform: `translateY(${first * ROW_H}px)` }}>
          {slice.map((r) => {
            const i = rowIndex.get(r) ?? -1;
            const isSel = selected === i;
            const ps = protoList(r);
            const settled = r.status !== "pending";
            const works = r.status === "working";
            const place = r.city ?? r.country ?? r.cc?.toUpperCase();
            return (
              <div
                key={`${r.raw}-${i}`}
                role="row"
                onClick={() => setSelected(isSel ? null : i)}
                style={{ height: ROW_H }}
                title={r.reason && !works ? r.reason : undefined}
                className={cx("ux-row num", isSel && "is-selected", !settled && "is-pending", checking && settled && "row-in")}
              >
                <i className={cx("ux-bar", barTone(r))} />

                <div data-col="proxy" className="min-w-0">
                  <div className="addr">
                    {r.host}
                    <span className="port">:{r.port}</span>
                    {r.auth && (
                      <Tag quiet title="This line carries a login">
                        Login
                      </Tag>
                    )}
                    {r.rotating && (
                      <Tag quiet title={`Exits from ${r.exitIp}, not the address you dialled`}>
                        Rotating
                      </Tag>
                    )}
                  </div>
                  {r.isp && (
                    <div className="net">
                      {r.isp}
                      {r.asn ? ` · ${r.asn}` : ""}
                    </div>
                  )}
                </div>

                <span data-col="protocol" className="chips">
                  {works ? (
                    protoChips(ps).map((c) => (
                      <Tag key={c.label} title={c.title}>
                        {c.label}
                      </Tag>
                    ))
                  ) : settled ? (
                    <span className="quiet">—</span>
                  ) : null}
                </span>

                <span data-col="anonymity" className="min-w-0 truncate">
                  {works ? (
                    r.anonymity ? (
                      <span className={GRADE_TEXT[r.anonymity]}>{r.anonymity}</span>
                    ) : (
                      <span className="quiet">Unknown</span>
                    )
                  ) : settled ? (
                    <span className={r.status === "timeout" ? "text-warn" : "text-danger"}>{failureShort(r)}</span>
                  ) : null}
                </span>

                <span data-col="location" className="exit">
                  {r.cc ? (
                    <span className="ux-flag" title={r.country}>
                      <span className={`fi fi-${r.cc}`} />
                    </span>
                  ) : (
                    settled && <span className="quiet">—</span>
                  )}
                  {r.cc && <span>{place}</span>}
                </span>

                <span data-col="keepalive">
                  {r.keepAlive ? (
                    <span title="Connection: Keep-Alive" className="text-ok">
                      <Icon.check className="h-4 w-4" />
                    </span>
                  ) : (
                    settled && <span className="quiet">—</span>
                  )}
                </span>

                <span data-col="server" className="quiet min-w-0 truncate">
                  {r.server ?? (settled ? "—" : "")}
                </span>

                {hasFraud && (
                  <span data-col="fraud" className="text-right">
                    <RowFraud r={r} fraud={fraud} settled={settled} />
                  </span>
                )}

                <div data-col="latency">
                  {r.latency != null ? (
                    <>
                      <div className="ms">{spaced(r.latency)} ms</div>
                      {r.timings?.[0] && <TimingLine timings={r.timings[0].timings} />}
                    </>
                  ) : (
                    settled && <div className="ms quiet">—</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {end && <div className="ux-end">{end}</div>}

      {/* The detail sheet: pinned to the bottom of the window, above the list. */}
      {selectedRow && (
        <div className="ux-sheet rise-in sticky bottom-0 z-20 px-6 pb-6 pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="num text-[20px] font-extrabold text-ink">
              {selectedRow.host}
              <span className="text-ink-soft">:{selectedRow.port}</span>
            </span>
            {protoList(selectedRow).map((p) => (
              <Tag key={p}>{p.toUpperCase()}</Tag>
            ))}
            {selectedRow.anonymity && <Tag tone={selectedRow.anonymity === "Transparent" ? "warn" : selectedRow.anonymity === "Elite" ? "ok" : "digi"}>{selectedRow.anonymity}</Tag>}
            {selectedRow.rotating && (
              <Tag tone="aqua" title="Traffic left from a different address than the one you dialled: a rotating gateway, a pool, or an onward chain">
                Rotating
              </Tag>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {onConnectRow && selectedRow.status === "working" && (
                <Button variant="solid" onClick={() => onConnectRow(selectedRow)} title={`Run a password-free proxy on ${thisDevice()} that forwards through this one`}>
                  <Icon.connect className="h-4 w-4" />
                  Connect through this
                </Button>
              )}
              {onCopyRow && (
                <Button onClick={copySelected}>
                  <Icon.copy className="h-4 w-4" />
                  {copied ? "Copied" : "Copy host:port"}
                </Button>
              )}
              <Button variant="text" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-x-9 gap-y-3">
            {/* Every dead row says why. "Dead" on its own is a guess. */}
            {selectedRow.reason && selectedRow.status !== "working" && selectedRow.status !== "pending" && (
              <Fact label="Why">{selectedRow.reason}</Fact>
            )}
            <Fact label="Location">
              {selectedRow.cc ? `${selectedRow.city ? `${selectedRow.city}, ` : ""}${selectedRow.country ?? selectedRow.cc.toUpperCase()}` : "Unknown"}
            </Fact>
            <Fact label="Network">{selectedRow.isp ? `${selectedRow.isp}${selectedRow.asn ? ` · ${selectedRow.asn}` : ""}` : "Unknown"}</Fact>
            <Fact label="Latency">{selectedRow.latency != null ? `${spaced(selectedRow.latency)} ms` : "None"}</Fact>
            {/* Only shown when we observed one: a dash here would read as "your
                traffic went nowhere" rather than "we could not tell". */}
            {selectedRow.exitIp && <Fact label="Exit address">{selectedRow.exitIp}</Fact>}
            {selectedRow.status === "working" && onFraud && <SheetFraud r={selectedRow} fraud={fraud} onFraud={onFraud} />}
            {selectedRow.server && <Fact label="Software">{selectedRow.server}</Fact>}
            {selectedRow.keepAlive && <Fact label="Keep-alive">Supported</Fact>}
            {selectedRow.udp != null && <Fact label="UDP">{selectedRow.udp ? "Relays UDP" : "No UDP relay"}</Fact>}
            {selectedRow.speedMbps != null && <Fact label="Throughput">{selectedRow.speedMbps} Mbit/s</Fact>}
            {selectedRow.judge === "trace" && selectedRow.status === "working" && (
              <Fact label="Judge">
                <span title="This proxy could not reach our own echo and was verified through the edge reflector instead, which cannot see request headers. The anonymity grade is capped at anonymous.">
                  Edge reflector, grade capped
                </span>
              </Fact>
            )}
            {selectedRow.source === "api" && <Fact label="Checked by">HProxy's servers</Fact>}
          </div>

          {selectedRow.timings && selectedRow.timings.length > 0 && (
            <div className="ux-divider mt-5 border-t pt-5">
              <Waterfalls timings={selectedRow.timings} />
            </div>
          )}

          {/* The evidence behind the grade: the difference between "this proxy
              announces itself" and "this proxy announces you". */}
          {selectedRow.leaks && selectedRow.leaks.length > 0 && (
            <div className="ux-divider mt-5 border-t pt-5">
              <p className="text-[12.5px] font-bold text-accent-ink">Headers this proxy added</p>
              <div className="mt-2 flex flex-col gap-1">
                {selectedRow.leaks.map((h) => (
                  <span key={h.name} className="num text-[14px] font-semibold">
                    <span className="text-ink-mute">{h.name}:</span> <span className="text-ink">{h.value}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A row's fraud cell: its score, "…" while asked, a dash when it has none to ask for. */
function RowFraud({ r, fraud, settled }: { r: Row; fraud?: Map<string, FraudRow>; settled: boolean }) {
  const ip = scoredIp(r);
  const row = ip ? fraud?.get(ip) : undefined;
  if (row) return <FraudCell row={row} />;
  return settled ? <span className="quiet">—</span> : null;
}

/** The sheet's fraud line: the score once asked, or the button that asks. */
function SheetFraud({ r, fraud, onFraud }: { r: Row; fraud?: Map<string, FraudRow>; onFraud: (ips: string[]) => void }) {
  const ip = scoredIp(r);
  const row = ip ? fraud?.get(ip) : undefined;
  return (
    <Fact label="Fraud score">
      {row ? (
        <FraudFact row={row} />
      ) : ip ? (
        <button type="button" className="ux-link" onClick={() => onFraud([ip])} title={`Score ${ip} with the service picked in Settings`}>
          Look it up <Icon.arrowRight className="h-3.5 w-3.5" />
        </button>
      ) : (
        <span className="text-ink-mute" title="The proxy is a name and no exit address was seen">
          No address to score
        </span>
      )}
    </Fact>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[12.5px] font-bold text-accent-ink">{label}</p>
      <p className="num mt-0.5 text-[15px] font-bold text-ink">{children}</p>
    </div>
  );
}
