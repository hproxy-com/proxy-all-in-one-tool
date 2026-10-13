import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Row } from "../../lib/checker";
import { headline, scoredIp, type FraudSet } from "../../lib/fraud";
import { isMobile, thisDevice } from "../../lib/tauri";
import { Speed } from "../connect/PlaceRow";
import { FraudCell, FraudFact } from "../FraudScore";
import PhoneSheet from "../phone/PhoneSheet";
import { Button, Icon, cx } from "../ui";
import { Waterfalls } from "./Waterfall";

/* The result list, in look D (2026-09-23): one grid row per proxy, and colour
   only where there is a judgement. A 4 px bar at the start of the row says how
   it went (green works, amber gives you away or timed out, red dead), the
   anonymity grade is the one coloured word. unfx's numbered circles, tinted
   rows and flag in a dashed ring are gone.

   Since 2026-10-12 the list stands on the page,
   not in a panel; the protocols are words, not grey tags; a login or a
   rotating exit is a small mark after the address; the network is its name
   (the AS number is in the sheet); the latency is the three bars and the
   milliseconds My proxies shows; no column title carries an "i" (the filters
   explain the same words). Keep-alive and Software left the row for the
   sheet, with the timings, which were a line of dashes under the latency.

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

type SortKey = "proxy" | "protocol" | "anonymity" | "location" | "fraud" | "latency";
type SortDir = "asc" | "desc";

/* The grid's tracks live in globals.css (.ux-head, .ux-row), with the
   narrower layouts; `data-col` is how those layouts drop a column.

   The proxy leads at the very left: its name when you named it in My
   proxies, else its address; under it, smaller, its flag, place and network
   (2026-10-12). The country had a column of its
   own; its title sorts by place now, beside "Proxy". */
const COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "proxy", label: "Proxy" },
  { key: "protocol", label: "Protocol" },
  { key: "anonymity", label: "Anonymity" },
  { key: "latency", label: "Latency", align: "right" },
];

/** A row's `host:port` the way My proxies writes an address (IPv6 in brackets). */
const addressOf = (r: Row) => `${r.host.includes(":") && !r.host.startsWith("[") ? `[${r.host}]` : r.host}:${r.port}`;

/** Once fraud scores are asked for, a column for them before the latency
    (`.ux-table.has-fraud` in globals.css gives it its track). */
const FRAUD_COLUMN: { key: SortKey; label: string; align?: "right" } = { key: "fraud", label: "Fraud", align: "right" };
const COLUMNS_WITH_FRAUD = [...COLUMNS.slice(0, -1), FRAUD_COLUMN, COLUMNS[COLUMNS.length - 1]];

function protoList(r: Row): string[] {
  return r.protocols && r.protocols.length ? r.protocols : r.protocol ? [r.protocol.toLowerCase()] : [];
}

/* The row's protocols in words, one per family so never more than two: HTTP
   and HTTPS together read "HTTP/S", SOCKS4 and SOCKS5 "SOCKS4/5". One line of
   plain text since 2026-10-12 (they were grey chips, two stacked in a row);
   the tooltip and the sheet list each one. */
function protoWords(ps: string[]): { words: string; title: string } {
  const family = (a: string, b: string, both: string) => {
    const hasA = ps.includes(a);
    const hasB = ps.includes(b);
    if (hasA && hasB) return [both];
    if (hasA || hasB) return [(hasA ? a : b).toUpperCase()];
    return [];
  };
  const words = [...family("http", "https", "HTTP/S"), ...family("socks4", "socks5", "SOCKS4/5")];
  return { words: words.join(" · "), title: ps.map((p) => p.toUpperCase()).join(", ") };
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

function sortValue(r: Row, key: SortKey, fraud?: Map<string, FraudSet>): string | number {
  switch (key) {
    case "fraud": {
      // Unscored rows sink in both directions, like unknown latency.
      const ip = scoredIp(r);
      const set = ip ? fraud?.get(ip) : undefined;
      return (set && headline(set).score?.score) ?? Number.MAX_SAFE_INTEGER;
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
    case "latency":
      // Unknown latency sorts last in BOTH directions, so "fastest first" never
      // opens with a wall of dead proxies.
      return r.latency ?? Number.MAX_SAFE_INTEGER;
  }
}

const spaced = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

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
  names,
}: {
  rows: Row[];
  visible: Row[];
  /** Names given in My proxies, by `host:port`. */
  names?: Map<string, string>;
  checking: boolean;
  /** The page's scroll container: the list virtualises against it. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The table's last line: where the other rows went. */
  end?: ReactNode;
  onCopyRow?: (r: Row) => void;
  /** Hand a working proxy to the Connect screen, login included. */
  onConnectRow?: (r: Row) => void;
  /** Fraud scores asked for so far, by address (lib/fraud.ts scoredIp). */
  fraud?: Map<string, FraudSet>;
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

  // The row a closing sheet still shows while it slides away.
  const [leaving, setLeaving] = useState<Row | undefined>(undefined);
  const detailRow = selectedRow ?? leaving;
  const phone = isMobile();
  const closeDetails = () => {
    setLeaving(selectedRow);
    setSelected(null);
  };

  /** One checked proxy in full: what the detail sheet shows. */
  const details = (r: Row, inSheet: boolean) => (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {/* Its name first when you named it in My proxies. */}
        {names?.get(addressOf(r)) && <span className="text-[20px] font-extrabold text-ink">{names.get(addressOf(r))}</span>}
        <span className="num text-[20px] font-extrabold text-ink">
          {r.host}
          <span className="text-ink-soft">:{r.port}</span>
        </span>
        {/* Words, not tags: the protocols, the grade in its colour, a rotating exit with its mark. */}
        {protoList(r).length > 0 && (
          <span className="text-[13px] font-semibold text-ink-mute">{protoList(r).map((p) => p.toUpperCase()).join(" · ")}</span>
        )}
        {r.anonymity && <span className={cx("text-[13px] font-bold", GRADE_TEXT[r.anonymity])}>{r.anonymity}</span>}
        {r.rotating && (
          <span
            className="inline-flex items-center gap-1 text-[13px] font-semibold text-ink-mute"
            title="Traffic left from a different address than the one you dialled: a rotating gateway, a pool, or an onward chain"
          >
            <Icon.refresh className="h-3.5 w-3.5" />
            Rotating
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {onConnectRow && r.status === "working" && (
            <Button variant="solid" onClick={() => onConnectRow(r)} title={`Run a password-free proxy on ${thisDevice()} that forwards through this one`}>
              <Icon.connect className="h-4 w-4" />
              Connect through this
            </Button>
          )}
          {onCopyRow && (
            <Button variant="text" onClick={copySelected}>
              <Icon.copy className="h-4 w-4" />
              {copied ? "Copied" : "Copy host:port"}
            </Button>
          )}
          {!inSheet && (
            <Button variant="text" onClick={closeDetails}>
              Close
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-9 gap-y-3">
        {/* Every dead row says why. "Dead" on its own is a guess. */}
        {r.reason && r.status !== "working" && r.status !== "pending" && (
          <Fact label="Why">{r.reason}</Fact>
        )}
        <Fact label="Location">
          {r.cc ? `${r.city ? `${r.city}, ` : ""}${r.country ?? r.cc.toUpperCase()}` : "Unknown"}
        </Fact>
        <Fact label="Network">{r.isp ? `${r.isp}${r.asn ? ` · ${r.asn}` : ""}` : "Unknown"}</Fact>
        <Fact label="Latency">{r.latency != null ? `${spaced(r.latency)} ms` : "None"}</Fact>
        {/* Only shown when we observed one: a dash here would read as "your
            traffic went nowhere" rather than "we could not tell". */}
        {r.exitIp && <Fact label="Exit address">{r.exitIp}</Fact>}
        {r.status === "working" && onFraud && <SheetFraud r={r} fraud={fraud} onFraud={onFraud} />}
        {r.server && <Fact label="Software">{r.server}</Fact>}
        {r.keepAlive && <Fact label="Keep-alive">Supported</Fact>}
        {r.udp != null && <Fact label="UDP">{r.udp ? "Carries UDP" : "No UDP"}</Fact>}
        {r.speedMbps != null && <Fact label="Throughput">{r.speedMbps} Mbit/s</Fact>}
        {r.judge === "trace" && r.status === "working" && (
          <Fact label="Judge">
            <span title="This proxy could not reach our own echo and was verified through the edge reflector instead, which cannot see request headers. The anonymity grade is capped at anonymous.">
              Edge reflector, grade capped
            </span>
          </Fact>
        )}
        {r.source === "api" && <Fact label="Checked by">HProxy's servers</Fact>}
      </div>

      {r.timings && r.timings.length > 0 && (
        <div className="ux-divider mt-5 border-t pt-5">
          <Waterfalls timings={r.timings} />
        </div>
      )}

      {/* The evidence behind the grade: the difference between "this proxy
          announces itself" and "this proxy announces you". */}
      {r.leaks && r.leaks.length > 0 && (
        <div className="ux-divider mt-5 border-t pt-5">
          <p className="text-[12.5px] font-bold text-accent-ink">Headers this proxy added</p>
          <div className="mt-2 flex flex-col gap-1">
            {r.leaks.map((h) => (
              <span key={h.name} className="num text-[14px] font-semibold">
                <span className="text-ink-mute">{h.name}:</span> <span className="text-ink">{h.value}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className={cx("ux-table", hasFraud && "has-fraud")}>
      {/* Pins under the search row once the filters have scrolled away. */}
      <div className="ux-head">
        <span />
        {columns.map((c) => {
          const sortButton = (key: SortKey, label: string) => {
            const active = sort?.key === key;
            return (
              <button type="button" onClick={() => toggleSort(key)} title={`Sort by ${label.toLowerCase()}`} className={cx(active && "is-active")}>
                {label}
                <Icon.chevronDown className={cx("h-3 w-3", active && sort?.dir === "asc" && "rotate-180")} />
              </button>
            );
          };
          return (
            <span key={c.key} data-col={c.key} className={cx("flex min-w-0 items-center gap-3 whitespace-nowrap", c.align === "right" && "justify-end")}>
              {sortButton(c.key, c.label)}
              {/* The proxy's second line is its place: sorting by it sits beside "Proxy". */}
              {c.key === "proxy" && sortButton("location", "Place")}
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
            const name = names?.get(addressOf(r));
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
                    {name ? (
                      <span className="name">{name}</span>
                    ) : (
                      <>
                        {r.host}
                        <span className="port">:{r.port}</span>
                      </>
                    )}
                    {/* Marks, not tags: a login, a rotating exit. */}
                    {r.auth && (
                      <span className="mark" title="This line carries a login">
                        <Icon.key />
                      </span>
                    )}
                    {r.rotating && (
                      <span className="mark" title={`Rotating: exits from ${r.exitIp}, not the address you dialled`}>
                        <Icon.refresh />
                      </span>
                    )}
                  </div>
                  {/* Smaller, under it: the address when a name stands above, then the flag, the place and the network. */}
                  {(name || r.cc || r.isp) && (
                    <div className="net" title={[r.country, r.asn].filter(Boolean).join(" · ") || undefined}>
                      {name && <span className="num">{addressOf(r)}</span>}
                      {r.cc && (
                        <span className="ux-flag">
                          <span className={`fi fi-${r.cc}`} />
                        </span>
                      )}
                      {place && <span>{place}</span>}
                      {r.isp && <span className="isp">{r.isp}</span>}
                    </div>
                  )}
                </div>

                <span data-col="protocol" className="protos" title={works ? protoWords(ps).title : undefined}>
                  {works ? protoWords(ps).words : settled ? <span className="quiet">—</span> : null}
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

                {hasFraud && (
                  <span data-col="fraud" className="text-right">
                    <RowFraud r={r} fraud={fraud} settled={settled} />
                  </span>
                )}

                <div data-col="latency" className="ms">
                  {r.latency != null ? <Speed ms={r.latency} /> : settled && <span className="quiet">—</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {end && <div className="ux-end">{end}</div>}

      {/* The detail sheet: pinned to the bottom of the window, above the list;
          on a phone it rises from the bottom like every sheet there. */}
      {phone ? (
        <PhoneSheet open={!!selectedRow} onClose={closeDetails}>
          {detailRow && <div className="ux-rowsheet">{details(detailRow, true)}</div>}
        </PhoneSheet>
      ) : (
        selectedRow && <div className="ux-sheet rise-in sticky bottom-0 z-20 px-6 pb-6 pt-5">{details(selectedRow, false)}</div>
      )}
    </div>
  );
}

/** A row's fraud cell: its score, "…" while asked, a dash when it has none to ask for. */
function RowFraud({ r, fraud, settled }: { r: Row; fraud?: Map<string, FraudSet>; settled: boolean }) {
  const ip = scoredIp(r);
  const set = ip ? fraud?.get(ip) : undefined;
  if (set) return <FraudCell set={set} />;
  return settled ? <span className="quiet">—</span> : null;
}

/** The sheet's fraud line: the score once asked, or the button that asks. */
function SheetFraud({ r, fraud, onFraud }: { r: Row; fraud?: Map<string, FraudSet>; onFraud: (ips: string[]) => void }) {
  const ip = scoredIp(r);
  const set = ip ? fraud?.get(ip) : undefined;
  return (
    <Fact label="Fraud score">
      {set ? (
        <FraudFact set={set} />
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
