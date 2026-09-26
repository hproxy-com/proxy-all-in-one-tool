import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import ResultsTable from "./ResultsTable";
import {
  SAMPLE,
  STATUS_RANK,
  applyCheck,
  exitsElsewhere,
  parseLines,
  readList,
  withGeo,
  type Row,
  type CheckResult,
} from "../../lib/checker";
import { hashSeed, mulberry32, simulateRow } from "../../lib/preview";
import {
  isTauri,
  startChecks,
  cancelChecks,
  onResult,
  onGeo,
  onDone,
  type GeoLabel,
  importProxyFile,
  exportTextFile,
  copyText,
} from "../../lib/tauri";
import { addRun, loadRuns } from "../../lib/history";
import { recordRun } from "../../lib/insights";
import { toCsv, toJson, toList } from "../../lib/export";
import { setCheckRunning } from "../../lib/runState";
import { fraudScores, fraudService, scoredIp, type FraudRow } from "../../lib/fraud";
import { geoApiUrl, protocolList, whatLeaves, type Settings } from "../../lib/settings";
import { Button, Card, Dropdown, Icon, Input, TextArea } from "../ui";
import { ANONS, EMPTY_FILTERS, FilterPanel, LATENCY_MAX, PROTO_LABEL, PROTOS, type Filters } from "./FilterPanel";

/* The Checker screen, in look D (chosen 2026-09-23).

   Idle (2026-09-24): one panel, one box, one button. The list is pasted or
   typed into the box, or a file dropped on it (or anywhere on the tab); the
   blue button says how many proxies it found. Under it, in plain words, the
   lines that are not proxies and why, read by the engine's own parser, so the
   count is the count the engine will check. The welcome page with four ways
   in and a paragraph of text is gone: people did not know which to press.

   Results, top to bottom: the counts as one line of text; the search with the
   actions beside it (Copy working, Export, New list or Stop), which stays at
   the top while the list scrolls; the filters in two columns of groups with
   the countries and "Showing X of Y" under them; then the table, whose header
   pins under the search row and whose last line says where the other rows
   went. The page scrolls as one, so a small window still reaches everything.
   unfx's floating bar and its Filtered / Total pills are gone. */

const spaced = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

const append = (prev: string, more: string) => (prev.trim() ? prev.replace(/\s*$/, "") + "\n" + more : more);

/* What the empty box says: that anything goes, and a few of the shapes. RFC
   5737 documentation addresses, so nothing real is shown. */
const PASTE_HERE = [
  "Paste your proxies here, in any format, as many as you have:",
  "198.51.100.7:8080",
  "198.51.100.7:8080:user:pass",
  "user:pass@gate.example.com:8000",
  "socks5://198.51.100.7:1080",
].join("\n");

/* Why a line is not a proxy, as the parser said it. The parser writes its
   reasons to follow a line number ("line 3: could not read ..."), so the first
   word gets its capital here. A reason quotes the line, or the part of it at
   fault, in backticks, and that part is set in the monospace face; a reason
   that quotes nothing gets the line in front. The first and the last backtick
   bound the quote, so a backtick inside the pasted line cannot split it. */
function Unreadable({ line, reason }: { line: string; reason: string }) {
  const clip = (s: string) => (s.length > 64 ? `${s.slice(0, 61)}...` : s);
  const open = reason.indexOf("`");
  const close = reason.lastIndexOf("`");
  const quotes = open >= 0 && close > open;
  const before = quotes ? reason.slice(0, open) : reason;
  return (
    <li className="text-[12.5px] font-medium leading-snug text-ink-mute">
      {!quotes && <span className="num mr-1.5 font-semibold text-ink">{clip(line)}</span>}
      {before.charAt(0).toUpperCase() + before.slice(1)}
      {quotes && (
        <>
          <span className="num font-semibold text-ink">{clip(reason.slice(open + 1, close))}</span>
          {reason.slice(close + 1)}
        </>
      )}
    </li>
  );
}

export default function CheckerConsole({
  settings,
  onConnect,
  onSaveList,
  seed,
  active = true,
}: {
  settings: Settings;
  onConnect?: (raw: string) => void;
  /** Keep the working rows as a list on the Connect tab. */
  onSaveList?: (lines: string[]) => void;
  /** Lines handed over from Connect ("Check this list"), checked on arrival. */
  seed?: { text: string; at: number } | null;
  /** False while another tab is showing: the screen stays alive behind it
      (a run keeps going), but its keyboard shortcuts stand down. */
  active?: boolean;
}) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  /* Fraud scores, by address, once asked for (the toolbar's "Fraud scores",
     or "Look it up" in a row's sheet). A new list starts without them; the
     session keeps what it asked (lib/fraud.ts), so asking again is free. */
  const [fraud, setFraud] = useState<Map<string, FraudRow>>(() => new Map());
  const [scoring, setScoring] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (rows.length === 0) setFraud(new Map());
  }, [rows.length]);
  const scoreFraud = (ips: string[]) => {
    const list = [...new Set(ips)];
    if (list.length === 0 || scoring) return;
    let done = 0;
    setScoring({ done, total: list.length });
    void fraudScores(list, settings.fraudService, settings.fraudKeys, (found) => {
      done = Math.min(list.length, done + found.length);
      setFraud((prev) => {
        const next = new Map(prev);
        for (const r of found) next.set(r.ip, r);
        return next;
      });
      setScoring({ done, total: list.length });
    }).finally(() => setScoring(null));
  };

  /* One object rather than six pieces of state, which is what lets Reset be
     `setFilters(EMPTY_FILTERS)` instead of six setters that will disagree. */
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  /* Open by default on a computer, as the old screen had it. On a phone the
     groups would push the results a screen down, so they start folded there;
     the countries line stays, with "Show filters" beside it. */
  const [filtersOpen, setFiltersOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 720);

  /* Publish "a run is in flight" so the updater can refuse to relaunch out from
     under it. Restarting mid-check silently discards every result the user has
     been waiting on, which for a large list can be an hour of work. */
  useEffect(() => {
    setCheckRunning(checking);
    return () => setCheckRunning(false);
  }, [checking]);
  /* Wall-clock start of the current run, and a slow tick that keeps the
     throughput readout moving while the run waits on slow timeouts. */
  const [runStart, setRunStart] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!checking) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [checking]);

  const liveRef = useRef<Row[]>([]);
  const dirtyRef = useRef(false);
  const flushTimerRef = useRef<number | null>(null);
  const unlistenRef = useRef<Array<() => void>>([]);
  const cancelledRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  /* The search row pins to the top of the page; the table's header pins under
     it. Its height changes with the window (the row wraps) and with a run (the
     progress line), so it is measured, and handed to the header as --stick. */
  const stickRef = useRef<HTMLDivElement>(null);
  const hasRows = rows.length > 0;
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const stick = stickRef.current;
    if (!scroller || !stick) return;
    // Not pinned on a phone (globals.css), so the header pins to the very top there.
    const measure = () =>
      scroller.style.setProperty("--stick", getComputedStyle(stick).position === "sticky" ? `${stick.offsetHeight}px` : "0px");
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stick);
    return () => ro.disconnect();
  }, [hasRows]);

  const listRead = useMemo(() => readList(text), [text]);
  const parsedCount = listRead.rows.length;

  const cleanup = () => {
    if (flushTimerRef.current !== null) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    unlistenRef.current.forEach((fn) => fn());
    unlistenRef.current = [];
  };
  useEffect(() => cleanup, []);

  /** Check the text area, or `listOverride` when lines arrive from elsewhere. */
  const run = async (listOverride?: string) => {
    if (checking) return;
    cleanup();
    const base = listOverride ?? text;
    // The sample is the browser preview's demo list, which the simulation "checks". The app
    // itself checks only what the person gave it: never addresses they did not enter.
    const demo = !isTauri() && !base.trim();
    const listText = demo ? SAMPLE : base;
    if (demo) setText(SAMPLE);
    const parsed = parseLines(listText);
    if (parsed.length === 0) return;

    setRows(parsed);
    setChecking(true);
    cancelledRef.current = false;
    dirtyRef.current = false;

    const live: Row[] = parsed.map((r) => ({ ...r }));
    liveRef.current = live;
    const startedAt = Date.now();
    setRunStart(startedAt);

    const index = new Map<string, number[]>();
    live.forEach((r, i) => {
      for (const k of new Set([r.raw, `${r.host}:${r.port}`])) {
        const a = index.get(k);
        if (a) a.push(i);
        else index.set(k, [i]);
      }
    });

    flushTimerRef.current = window.setInterval(() => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        setRows(live.slice());
      }
    }, 80);

    /* Working rows whose traffic leaves somewhere other than the address that
       was dialled (a rotating gateway), by exit. Filled as results arrive. */
    const byExit = new Map<string, number[]>();

    const applyResult = (o: CheckResult) => {
      /* Match on BOTH keys and take the union, not the first that hits.
         The engine deduplicates before checking, so one result may be the only
         answer several pasted rows will ever get, including rows written in a
         different spelling of the same endpoint (`1.2.3.4:80` vs
         `http://1.2.3.4:80`). Falling back to the endpoint key only when the
         raw key missed would leave those rows pending forever, and they would
         then be marked dead at the end of the run: a working proxy shown as
         dead purely because the user pasted it twice. */
      const byRaw = index.get(o.input);
      const byEndpoint = o.ip && o.port != null ? index.get(`${o.ip}:${o.port}`) : undefined;
      if (!byRaw && !byEndpoint) return;
      const hits = byRaw && byEndpoint ? Array.from(new Set([...byRaw, ...byEndpoint])) : (byRaw ?? byEndpoint)!;
      for (const i of hits) {
        if (live[i].status === "pending") {
          live[i] = applyCheck(live[i], o);
          dirtyRef.current = true;
          if (exitsElsewhere(live[i])) {
            const exit = live[i].exitIp!;
            const a = byExit.get(exit);
            if (a) a.push(i);
            else byExit.set(exit, [i]);
          }
        }
      }
    };

    const finish = (_cancelled: boolean) => {
      cleanup();
      for (let i = 0; i < live.length; i++) {
        if (live[i].status === "pending") live[i] = { ...live[i], status: "dead" };
      }
      setRows(live.slice());
      setChecking(false);
      const alive = live.filter((r) => r.status === "working").length;
      addRun({ ts: startedAt, total: live.length, alive, durationMs: Date.now() - startedAt });
      /* Fold the run into the per-network aggregates. Counts and a small
         latency histogram per ASN, never the addresses themselves. */
      recordRun(live);
    };

    /* Locations are looked up beside the check and arrive in waves. A row that
       settled before its wave gets its flag here; a row that settles after
       already carries it in its result. A label is a fact about one address:
       a working row that exits elsewhere takes only its exit's label, every
       other row takes the label of the address that was dialled. */
    const byHost = new Map<string, number[]>();
    live.forEach((r, i) => {
      const a = byHost.get(r.host);
      if (a) a.push(i);
      else byHost.set(r.host, [i]);
    });
    const applyGeo = (labels: GeoLabel[]) => {
      for (const g of labels) {
        for (const i of byExit.get(g.ip) ?? []) {
          live[i] = withGeo(live[i], g);
          dirtyRef.current = true;
        }
        for (const i of byHost.get(g.ip) ?? []) {
          if (exitsElsewhere(live[i])) continue;
          live[i] = withGeo(live[i], g);
          dirtyRef.current = true;
        }
      }
    };

    if (isTauri()) {
      try {
        unlistenRef.current.push(await onResult(applyResult));
        unlistenRef.current.push(await onGeo(applyGeo));
        unlistenRef.current.push(await onDone((d) => finish(d.cancelled)));
        await startChecks({
          proxies: parsed.map((r) => r.raw),
          concurrency: settings.concurrency,
          timeoutMs: settings.timeoutMs,
          retries: settings.retries,
          protocols: protocolList(settings.protocols),
          geoApiUrl: geoApiUrl(settings),
          source: settings.source,
          measureUdp: settings.measureUdp,
          measureSpeed: settings.measureSpeed,
        });
      } catch {
        finish(false);
      }
      return;
    }

    /* Browser preview: seeded simulation through the same pipeline. Seeded from
       the list AND the run number, so the first run on a fresh profile is
       always identical while re-running gives different results. */
    const rng = mulberry32(hashSeed(`${parsed.map((r) => r.raw).join("|")}#${loadRuns().length}`));
    for (let i = 0; i < live.length; i++) {
      if (cancelledRef.current) break;
      await new Promise((r) => setTimeout(r, 12 + Math.floor(rng() * 55)));
      if (live[i].status === "pending") {
        live[i] = simulateRow(live[i], rng);
        dirtyRef.current = true;
      }
    }
    finish(cancelledRef.current);
  };

  // Preview/screenshot helper: ?demo auto-runs the sample once.
  const demoRan = useRef(false);
  useEffect(() => {
    if (demoRan.current) return;
    const demo = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("demo") : null;
    if (demo !== null && demo !== "connect") {
      demoRan.current = true;
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [pendingSeed, setPendingSeed] = useState<string | null>(null);
  useEffect(() => {
    if (seed?.text) setPendingSeed(seed.text);
  }, [seed]);
  useEffect(() => {
    if (pendingSeed === null || checking) return;
    setText(pendingSeed);
    setPendingSeed(null);
    void run(pendingSeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSeed, checking]);

  const cancel = async () => {
    if (!checking) return;
    cancelledRef.current = true;
    if (isTauri()) await cancelChecks();
  };

  const working = rows.filter((r) => r.status === "working");
  const dead = rows.filter((r) => r.status === "dead");
  const timeouts = rows.filter((r) => r.status === "timeout");
  const checkedCount = rows.filter((r) => r.status !== "pending").length;
  const avgLatency = working.length
    ? Math.round(working.reduce((a, r) => a + (r.latency ?? 0), 0) / working.length)
    : 0;
  const elite = working.filter((r) => r.anonymity === "Elite").length;

  /* How many working rows carry each protocol and each grade: the numbers
     beside the ticks, as in unfx, and the live tallies during a run. */
  const counts = useMemo(() => {
    const proto: Record<string, number> = { http: 0, https: 0, socks4: 0, socks5: 0 };
    const anon: Record<string, number> = { Elite: 0, Anonymous: 0, Transparent: 0 };
    for (const r of rows) {
      if (r.status !== "working") continue;
      const ps = r.protocols?.length ? r.protocols : r.protocol ? [r.protocol.toLowerCase()] : [];
      for (const p of ps) if (p.toLowerCase() in proto) proto[p.toLowerCase()]++;
      if (r.anonymity) anon[r.anonymity]++;
    }
    return { proto, anon };
  }, [rows]);

  /* Throughput + ETA. `tick` is in the dependency list on purpose: it is what
     makes these advance while the run is waiting on slow timeouts. */
  const { rate, etaLabel } = useMemo(() => {
    void tick;
    if (!runStart || !checking || checkedCount === 0) return { rate: 0, etaLabel: null as string | null };
    const elapsedSec = (Date.now() - runStart) / 1000;
    if (elapsedSec < 0.75) return { rate: 0, etaLabel: null };
    const perSec = checkedCount / elapsedSec;
    const left = Math.max(0, rows.length - checkedCount);
    const secs = perSec > 0 ? Math.ceil(left / perSec) : 0;
    const label =
      left === 0 ? null : secs >= 90 ? `about ${Math.ceil(secs / 60)} min left` : `about ${Math.max(1, secs)} s left`;
    return { rate: perSec, etaLabel: label };
  }, [tick, runStart, checking, checkedCount, rows.length]);

  /* How many groups are actually narrowing the list, so a hidden panel can
     never silently hide the fact that results are being filtered. */
  const activeFilterCount =
    (PROTOS.every((p) => filters.proto[p]) ? 0 : 1) +
    (ANONS.every((a) => filters.anon[a]) ? 0 : 1) +
    (filters.showDead ? 1 : 0) +
    (filters.onlyKeepAlive ? 1 : 0) +
    (filters.onlyRotating ? 1 : 0) +
    (filters.maxLatency < LATENCY_MAX ? 1 : 0) +
    (filters.ports.trim() ? 1 : 0) +
    (filters.countries.length ? 1 : 0);

  /* Parsed once per render rather than per row. */
  const portRule = useMemo(() => {
    const list = filters.ports
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return list.length ? { list, allow: filters.portsAllow } : null;
  }, [filters.ports, filters.portsAllow]);

  /* The rows the filters let through, and how many dead ones "Show dead"
     would add: the table's last line says where the others went. */
  const { visible, hiddenDead } = useMemo(() => {
    const allProto = PROTOS.every((p) => filters.proto[p]);
    const allAnon = ANONS.every((a) => filters.anon[a]);
    const q = filters.search.trim().toLowerCase();

    /* Every filter but "Show dead". */
    const match = (r: Row) => {
      if (filters.onlyKeepAlive && !r.keepAlive) return false;
      if (filters.onlyRotating && !r.rotating) return false;
      if (!allProto) {
        const ps = r.protocols ?? (r.protocol ? [r.protocol.toLowerCase()] : []);
        if (!ps.some((p) => filters.proto[p.toLowerCase()])) return false;
      }
      if (!allAnon && (!r.anonymity || !filters.anon[r.anonymity])) return false;
      if (filters.maxLatency < LATENCY_MAX && r.latency != null && r.latency > filters.maxLatency) return false;
      if (filters.countries.length && (!r.cc || !filters.countries.includes(r.cc))) return false;
      if (portRule) {
        const inList = portRule.list.includes(Number(r.port));
        if (portRule.allow !== inList) return false;
      }
      if (q) {
        const hay =
          `${r.host} ${r.port} ${r.cc ?? ""} ${r.country ?? ""} ${r.city ?? ""} ${r.isp ?? ""} ${r.asn ?? ""} ${r.server ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };

    const kept: Row[] = [];
    let hidden = 0;
    for (const r of rows) {
      // A row still being checked always shows: hiding it would make the list
      // jump as results land, and it has no attributes to filter on yet.
      if (r.status === "pending") kept.push(r);
      else if (!match(r)) continue;
      // Survivors only, until asked otherwise.
      else if (r.status === "working" || filters.showDead) kept.push(r);
      else hidden++;
    }
    kept.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
    return { visible: kept, hiddenDead: hidden };
  }, [rows, filters, portRule]);

  /* Country facet, ordered by how many rows each has. */
  const countryFacet = useMemo(() => {
    const c = new Map<string, { count: number; name?: string }>();
    for (const r of rows) {
      if (!r.cc) continue;
      const e = c.get(r.cc);
      if (e) e.count++;
      else c.set(r.cc, { count: 1, name: r.country });
    }
    return [...c.entries()]
      .map(([cc, e]) => ({ cc, ...e }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 14);
  }, [rows]);

  const filteredWorking = visible.filter((r) => r.status === "working");
  const settled = visible.filter((r) => r.status !== "pending");

  const copyWorking = async () => {
    await copyText(toList(filteredWorking));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const downloadTxt = () => exportTextFile("working-proxies.txt", toList(filteredWorking));
  /* Exports live in lib/export.ts, with tests. */
  const downloadCsv = () => exportTextFile("proxy-check-results.csv", toCsv(visible), "text/csv");
  const downloadJson = () => exportTextFile("proxy-check-results.json", toJson(visible), "application/json");

  const textRef = useRef<HTMLTextAreaElement>(null);
  /* Typing in by hand opens the list before there is anything in it. */

  /* Ctrl+V anywhere on the tab pastes into the list, unless a field has the
     keyboard (the search, the ports). The paste event carries the text, so
     this needs no clipboard permission. */
  useEffect(() => {
    if (!active) return;
    const onPasteAnywhere = (e: ClipboardEvent) => {
      if (rows.length > 0) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, [contenteditable]") || t.isContentEditable)) return;
      const pasted = e.clipboardData?.getData("text") ?? "";
      if (!pasted.trim()) return;
      e.preventDefault();
      setText((prev) => append(prev, pasted));
    };
    document.addEventListener("paste", onPasteAnywhere);
    return () => document.removeEventListener("paste", onPasteAnywhere);
  }, [active, rows.length]);
  const onUpload = async () => {
    const t = await importProxyFile();
    if (t) setText((prev) => append(prev, t));
  };
  const dragOn = (e: DragEvent) => {
    e.preventDefault();
    if (!dragActive) setDragActive(true);
  };
  const dragOff = (e: DragEvent) => {
    // Leaving for a child of the page is not leaving the page.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(false);
  };
  const onDropFiles = (e: DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      file.text().then((t) => setText((prev) => append(prev, t)));
      return;
    }
    const t = e.dataTransfer.getData("text");
    if (t) setText((prev) => append(prev, t));
  };

  /* Keyboard control. Ctrl+Enter deliberately works from inside the text area
     (that is where you are when you want to run), and Escape only intercepts
     while a check is actually in flight. */
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        void run();
      } else if (e.key === "Escape" && checking) {
        e.preventDefault();
        void cancel();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "f" && rows.length > 0) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "c" && filteredWorking.length > 0) {
        e.preventDefault();
        void copyWorking();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, checking, rows.length, filteredWorking.length, text, settings]);

  if (rows.length === 0) {
    return (
      <div className="relative h-full overflow-y-auto" onDragOver={dragOn} onDragLeave={dragOff} onDrop={onDropFiles}>
        <div className="mx-auto flex min-h-full max-w-[1600px] flex-col gap-3 px-6 pb-6 pt-1.5 max-sm:px-3">
          <Card fill pad="roomy">
            <h1 className="text-[24px] font-extrabold tracking-[-0.02em] text-ink">Check your proxies</h1>
            <div className="relative mt-4 min-h-[260px] flex-1">
              <TextArea value={text} onChange={setText} placeholder={PASTE_HERE} label="Proxy list" inputRef={textRef} />
              {/* The file can be dropped right here too. Only on the empty box:
                  over a list the badge would sit on the first line. */}
              {!text.trim() && (
                <span className="drop-hint is-inside" aria-hidden="true">
                  <Icon.drop className="h-4 w-4" />
                  Drop a file
                </span>
              )}
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button variant="solid" size="lg" onClick={() => void run()} title="Ctrl+Enter" disabled={parsedCount === 0}>
                <Icon.listCheck className="h-[18px] w-[18px]" />
                {parsedCount > 0 ? `Check ${spaced(parsedCount)}` : "Check"}
              </Button>
              {/* A phone cannot drop a file: this is its way in. */}
              <Button variant="text" onClick={() => void onUpload()}>
                <Icon.file className="h-4 w-4" />
                Open a file
              </Button>
              {/* What the box holds, and Clear beside it: one group, so on a
                  phone it moves under the buttons as one line. The count may
                  wrap there: a long list's numbers do not fit on one line. */}
              {text.trim() && (
                <div className="ml-auto flex items-center gap-x-3 max-sm:w-full max-sm:justify-between">
                  <span className="num text-[13px] font-semibold text-ink-mute">
                    <b className="text-ink">{spaced(parsedCount)}</b> {parsedCount === 1 ? "proxy" : "proxies"}
                    {listRead.rows.some((r) => r.auth) && <>, {spaced(listRead.rows.filter((r) => r.auth).length)} with a login</>}
                    {listRead.duplicates > 0 && <>, {spaced(listRead.duplicates)} pasted twice</>}
                  </span>
                  <Button variant="text" onClick={() => setText("")}>
                    Clear
                  </Button>
                </div>
              )}
            </div>

            {listRead.unread.length > 0 && (
              <div className="mt-4 rounded-[12px_4px_12px_4px] bg-[var(--well)] px-3.5 py-3">
                <p className="text-[13px] font-bold text-warn">
                  {listRead.unread.length === 1
                    ? "1 line is not a proxy and is left out"
                    : `${spaced(listRead.unread.length)} lines are not proxies and are left out`}
                </p>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {listRead.unread.slice(0, 3).map((u, i) => (
                    <Unreadable key={i} line={u.line} reason={u.reason} />
                  ))}
                  {listRead.unread.length > 3 && (
                    <li className="text-[12.5px] font-medium text-ink-soft">and {spaced(listRead.unread.length - 3)} more</li>
                  )}
                </ul>
              </div>
            )}

            <p className="mt-4 text-[12.5px] font-medium leading-relaxed text-ink-soft">{whatLeaves(settings)}</p>
          </Card>

          {/* The "What you have learned so far" panel (InsightsPanel.tsx) is off the screen since
              2026-09-24: a list of network names and percentages under the checker read as noise.
              The component and the counts it reads are kept, so it can come back in one line. */}

        </div>

        {dragActive && (
          <div className="drop-veil" aria-hidden="true">
            <span>
              <Icon.drop className="h-7 w-7" />
              Drop your proxy file to load it
            </span>
          </div>
        )}
      </div>
    );
  }

  const pct = rows.length ? Math.round((checkedCount / rows.length) * 100) : 0;
  const showDead = (on: boolean) => setFilters((f) => ({ ...f, showDead: on }));

  /* The table's last line: where the rows that are not showing went. Nothing
     while a run is in flight, since the rows still being checked are on it. */
  const end = checking ? null : hiddenDead > 0 ? (
    <>
      {visible.length === 0 ? "All" : "The other"} {spaced(hiddenDead)} {hiddenDead === 1 ? "is" : "are"} dead and hidden.
      <button type="button" className="ux-link" onClick={() => showDead(true)}>
        Show {hiddenDead === 1 ? "it" : "them"} <Icon.arrowRight className="h-3.5 w-3.5" />
      </button>
    </>
  ) : visible.length === 0 ? (
    <>
      Nothing matches these filters.
      <button type="button" className="ux-link" onClick={() => setFilters(EMPTY_FILTERS)}>
        Reset them <Icon.arrowRight className="h-3.5 w-3.5" />
      </button>
    </>
  ) : filters.showDead && settled.some((r) => r.status !== "working") ? (
    <>
      Showing the dead ones too.
      <button type="button" className="ux-link" onClick={() => showDead(false)}>
        Hide them <Icon.arrowRight className="h-3.5 w-3.5" />
      </button>
    </>
  ) : visible.length === rows.length ? (
    "That is every proxy on the list."
  ) : (
    "That is every proxy these filters let through."
  );

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-3 px-6 pb-6 pt-1.5 max-sm:px-3">
        {/* The counts: a line of text, not a row of coloured pills. */}
        <div className="ux-summary num">
          <span className="count">
            <i className="dot tone-ok" />
            <b>{spaced(working.length)}</b> working
          </span>
          <span className="count">
            <i className="dot tone-danger" />
            <b>{spaced(dead.length)}</b> dead
          </span>
          <span className="count">
            <i className="dot tone-warn" />
            <b>{spaced(timeouts.length)}</b> timeout
          </span>
          <span className="sep" />
          {PROTOS.map((p) => (
            <span key={p} className="count">
              {PROTO_LABEL[p]} <b>{spaced(counts.proto[p])}</b>
            </span>
          ))}
          {working.length > 0 && (
            <span className="aside">
              <b>{spaced(avgLatency)} ms</b> average · <b>{spaced(elite)}</b> elite
            </span>
          )}
        </div>

        {/* The search and what you take away, pinned while the list scrolls. */}
        <div ref={stickRef} className="ux-stick -my-1.5 flex flex-col gap-3 pb-3 pt-1.5">
          {checking && (
            <div className="ux-progress">
              <div className="bar" style={{ width: `${pct}%` }} />
              <div className="label num">
                {spaced(checkedCount)} / {spaced(rows.length)}
                {rate > 0 ? ` · ${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} per second` : ""}
                {etaLabel ? ` · ${etaLabel}` : ""}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-[1_1_300px]">
              <Input
                icon="search"
                value={filters.search}
                onChange={(v) => setFilters((f) => ({ ...f, search: v }))}
                placeholder="Search an address, a country, a network"
                label="Search the results"
                inputRef={searchRef}
              />
            </span>
            <Button variant="solid" onClick={() => void copyWorking()} disabled={filteredWorking.length === 0} title="Ctrl+Shift+C">
              <Icon.copy className="h-4 w-4" />
              {copied ? (
                "Copied"
              ) : (
                <span>
                  Copy {spaced(filteredWorking.length)}
                  {/* A phone keeps the number; the word would wrap the row. */}
                  <span className="max-[480px]:hidden"> working</span>
                </span>
              )}
            </Button>
            <Button
              onClick={() => scoreFraud(filteredWorking.map((r) => scoredIp(r)).filter((ip): ip is string => !!ip))}
              disabled={!!scoring || filteredWorking.length === 0}
              title={`The fraud score of every working proxy shown, one lookup each at ${fraudService(settings.fraudService).name} (Settings, Fraud score)`}
            >
              <Icon.shield className="h-4 w-4" />
              {scoring ? (
                `${spaced(scoring.done)} of ${spaced(scoring.total)}`
              ) : (
                <span>
                  Fraud<span className="max-[480px]:hidden"> scores</span>
                </span>
              )}
            </Button>
            <Dropdown
              label="Export"
              icon={<Icon.download className="h-4 w-4" />}
              onMain={downloadTxt}
              disabled={settled.length === 0}
              items={[
                { label: "Working list as .txt", note: "host:port, one per line, what you paste elsewhere", onClick: downloadTxt },
                { label: "Every row shown as .csv", note: "every column, the timing phases, the leaked headers", onClick: downloadCsv },
                { label: "Every row shown as .json", note: "the same, with every transport's timings", onClick: downloadJson },
                ...(onSaveList && filteredWorking.length > 0
                  ? [
                      {
                        label: "Save the working ones as a list",
                        note: "then connect through them, rotating, on the Connect tab",
                        onClick: () => onSaveList(filteredWorking.map((r) => r.raw)),
                      },
                    ]
                  : []),
              ]}
            />
            {checking ? (
              <Button variant="danger" onClick={() => void cancel()} title="Esc">
                <Icon.power className="h-4 w-4" />
                Stop
              </Button>
            ) : (
              <Button variant="text" onClick={() => setRows([])}>
                New list
              </Button>
            )}
          </div>
        </div>

        <FilterPanel
          filters={filters}
          setFilters={setFilters}
          counts={counts}
          countries={countryFacet}
          showing={visible.length}
          total={rows.length}
          open={filtersOpen}
          onToggleOpen={() => setFiltersOpen((v) => !v)}
          activeCount={activeFilterCount}
        />

        <ResultsTable
          rows={rows}
          visible={visible}
          checking={checking}
          scrollRef={scrollRef}
          end={end}
          onCopyRow={(r) => void copyText(`${r.host}:${r.port}`)}
          onConnectRow={onConnect ? (r) => onConnect(r.raw) : undefined}
          fraud={fraud}
          onFraud={scoreFraud}
        />
      </div>
    </div>
  );
}
