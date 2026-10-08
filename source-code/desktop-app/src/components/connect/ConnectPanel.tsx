import { useEffect, useRef, useState } from "react";
import {
  checkLine,
  connectProbe,
  connectRotate,
  connectSetProbe,
  connectStart,
  connectStatus,
  connectStop,
  copyText,
  onRelayChanged,
  parseLine,
  type ConnectStatus,
  type ParsedLine,
  type RelayHealth,
} from "../../lib/tauri";
import { countryName, type CheckResult } from "../../lib/checker";
import { cachedScore, fraudScores, type FraudRow } from "../../lib/fraud";
import type { Settings } from "../../lib/settings";
import {
  addressInUse,
  freeCountryName,
  lineParts,
  loadTarget,
  placeOf,
  ruleWords,
  saveTarget,
  verdictOf,
  type Target,
  type Verdict,
} from "../../lib/connect";
import {
  addManySaved,
  addSaved,
  forget,
  forgetList,
  freeListName,
  listUsed,
  loadLists,
  loadSaved,
  makeList,
  remember,
  saveLists,
  saveSaved,
  upsertList,
  withVerdict,
  type SavedList,
  type SavedProxy,
  type SavedVerdict,
} from "../../lib/saved";
import { isMobile, isTauri, leakDns, openExternal, zoneMatchAgain, zoneStatus, type DnsLeak, type ZoneStatus } from "../../lib/tauri";
import {
  DATE_TIME_SETTINGS,
  dnsRow,
  EXTENSION_PAGE,
  languageRow,
  localTimeZone,
  timezoneRow,
  webrtcRow,
  type LeakAction,
  type LeakRow,
} from "../../lib/leaks";
import { sourceOfTarget } from "../../lib/connectControl";
import ConnectionCard, { type Phase, type TargetView } from "./ConnectionCard";
import { Icon } from "../ui";
import Destinations, { type DestTab } from "./Destinations";

/* Connect: a VPN, for proxies. It works like a VPN app, connects through
   proxies, keeps saved lists, and stays as smooth as possible.

   Under it, as before, a password-free proxy on this computer that forwards to
   the real one with the login attached, so every program can use it, and the
   system proxy set and put back exactly as found.

   What changed is the shape. On the left the connection, like a VPN's main
   card: the state, one switch, the route, and a light behind it when the
   connection is up. On the right where to go, like a VPN's location list:
   your saved proxies (paste one, or a whole list, and each becomes a saved
   proxy), your lists (connect to many proxies as one, rotating by a rule),
   and the free pool by country. The last place is remembered, so the app
   opens one click away from reconnecting. Switching places while connected
   is one click: the relay builds the new connection before dropping the old.
   Nothing here is a modal. */

const POLL_MS = 1000;
/** How long after the line settles before it is checked for real. */
const PRECHECK_DELAY_MS = 700;

type Busy = "" | "connecting" | "stopping" | "rotating" | "probing";

type Precheck =
  | { state: "idle" }
  | { state: "checking"; line: string }
  | { state: "done"; line: string; result: CheckResult; verdict: Verdict };

function savedVerdictOf(r: CheckResult, at: number): SavedVerdict {
  return {
    ok: r.alive,
    latencyMs: r.latency_ms ?? undefined,
    cc: r.country_code?.toLowerCase() ?? undefined,
    place: placeOf(r),
    exitIp: r.exit_ip ?? undefined,
    anonymity: r.anonymity ?? undefined,
    at,
  };
}

function savedVerdictOfHealth(h: RelayHealth): SavedVerdict {
  return {
    ok: h.ok,
    latencyMs: h.latency_ms ?? undefined,
    cc: h.country_code?.toLowerCase() ?? undefined,
    place: placeOf(h),
    exitIp: h.exit_ip ?? undefined,
    at: h.checked_at_ms,
  };
}

const tabOf = (t: Target | null): DestTab => (t?.kind === "list" ? "lists" : t?.kind === "free" ? "free" : "proxies");

export default function ConnectPanel({
  initialLine,
  onLineConsumed,
  initialListId,
  onListConsumed,
  onCheckLines,
  settings,
  onSettings,
}: {
  /** A proxy handed over from the checker ("Connect through this"). */
  initialLine?: string;
  onLineConsumed?: () => void;
  /** A list the checker just saved ("Save the working ones as a list"). */
  initialListId?: string;
  onListConsumed?: () => void;
  /** Hand lines to the Check tab and check them there. */
  onCheckLines?: (lines: string[]) => void;
  settings: Settings;
  /** Change a setting from here (the leak check's "Match it while connected"). */
  onSettings: (patch: Partial<Settings>) => void;
}) {
  const [saved, setSaved] = useState<SavedProxy[]>(() => loadSaved());
  const [lists, setLists] = useState<SavedList[]>(() => loadLists());
  const [listsSaveFailed, setListsSaveFailed] = useState(false);
  const [target, setTarget] = useState<Target | null>(() => loadTarget());
  /* The list opens on My proxies, whatever was picked last: the app is for
     people connecting proxies of their own (his call, 2026-09-28), and free
     proxies are the extra. The place picked last stays remembered for the
     switch, and "Change" on the card opens its tab. */
  const [tab, setTab] = useState<DestTab>("proxies");
  // The Free tab opens on the country and protocol of a free place picked last.
  const [freeSocks5, setFreeSocks5] = useState(() => {
    const t = loadTarget();
    return t?.kind === "free" ? t.socks5 : false;
  });
  const [freeCountry, setFreeCountry] = useState(() => {
    const t = loadTarget();
    return t?.kind === "free" ? t.country : "";
  });

  const [line, setLine] = useState("");
  const [parsed, setParsed] = useState<ParsedLine | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [precheck, setPrecheck] = useState<Precheck>({ state: "idle" });
  const [recheck, setRecheck] = useState(0);
  const [testing, setTesting] = useState<{ done: number; total: number } | null>(null);

  const [useSystem, setUseSystem] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [listen, setListen] = useState("");
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [connected, setConnected] = useState<Target | null>(null);
  const [busy, setBusy] = useState<Busy>("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [incoming, setIncoming] = useState<{ text: string; at: number } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const takeText = (text: string) => {
    if (!text.trim()) return;
    // On My lists a paste starts a list there; anywhere else it goes to My proxies.
    setTab((cur) => (cur === "lists" ? "lists" : "proxies"));
    setIncoming({ text, at: Date.now() });
  };

  /* Ctrl+V anywhere on Connect (unless a field has the keyboard): one proxy
     goes into the field, a list opens the review, and on My lists a new list
     starts with it, so pasting a list takes no extra step. The paste event
     carries the text, so no clipboard permission is
     needed. */
  useEffect(() => {
    const onPasteAnywhere = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, [contenteditable]") || t.isContentEditable)) return;
      const pasted = e.clipboardData?.getData("text") ?? "";
      if (!pasted.trim()) return;
      e.preventDefault();
      takeText(pasted);
    };
    document.addEventListener("paste", onPasteAnywhere);
    return () => document.removeEventListener("paste", onPasteAnywhere);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The raw line of the fixed proxy in use, so probes can update its saved verdict. */
  const connectedLine = useRef<string | null>(null);
  const lastHealthAt = useRef<number>(0);
  const lineRef = useRef<HTMLInputElement>(null);
  const destRef = useRef<HTMLDivElement>(null);

  useEffect(() => saveSaved(saved), [saved]);
  useEffect(() => setListsSaveFailed(!saveLists(lists)), [lists]);
  useEffect(() => saveTarget(target), [target]);

  // Handed over from the checker: one proxy, saved and picked, not connected.
  useEffect(() => {
    if (!initialLine) return;
    const t = initialLine.trim();
    setSaved((l) => addSaved(l, t));
    setTarget({ kind: "fixed", line: t });
    setTab("proxies");
    onLineConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLine]);

  // A list the checker saved while this screen was closed: read it, pick it.
  useEffect(() => {
    if (!initialListId) return;
    setLists(loadLists());
    setTarget({ kind: "list", id: initialListId });
    setTab("lists");
    onListConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialListId]);

  useEffect(() => {
    void connectStatus().then(setStatus).catch(() => {});
  }, []);

  const running = status?.running ?? false;

  // The time zone match (src-tauri/src/timezone.rs does it; the leak check
  // shows it): read once here, on every connect and disconnect, and with the
  // card while connected.
  const [zone, setZone] = useState<ZoneStatus | null>(null);
  useEffect(() => {
    void zoneStatus().then(setZone).catch(() => {});
  }, [running]);

  // While connected, the card is live: the counters, the uptime and the
  // latest probe, once a second. Cheap: the status is in memory on the Rust side.
  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => {
      setNow(Date.now());
      void connectStatus().then(setStatus).catch(() => {});
      void zoneStatus().then(setZone).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(h);
  }, [running]);

  // The probe follows the "Connect check" setting while connected.
  const probeUrl = settings.connectProbeUrl;
  const appliedProbe = useRef(probeUrl);
  useEffect(() => {
    if (!running || appliedProbe.current === probeUrl) return;
    appliedProbe.current = probeUrl;
    void connectSetProbe(probeUrl)
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)));
  }, [probeUrl, running]);

  // A probe through a fixed proxy is also the freshest word on the saved line.
  useEffect(() => {
    const h = status?.health;
    const l = connectedLine.current;
    if (!running || !h || !l || h.checked_at_ms === lastHealthAt.current) return;
    lastHealthAt.current = h.checked_at_ms;
    setSaved((list) => withVerdict(list, l, savedVerdictOfHealth(h)));
  }, [status, running]);

  // Read the line as it is typed, with the engine's parser, so the person
  // sees "host 1.2.3.4, port 8080, with login" or the exact reason it cannot
  // be read, before pressing anything.
  useEffect(() => {
    const t = line.trim();
    if (!t) {
      setParsed(null);
      setParseError(null);
      return;
    }
    let cancelled = false;
    const h = setTimeout(() => {
      parseLine(t)
        .then((p) => {
          if (cancelled) return;
          setParsed(p);
          setParseError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setParsed(null);
          setParseError(String(e));
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [line]);

  // Then check it for real: one probe with the engine, location included, a
  // moment after the line settles. The answer sits under the field before
  // anything is pressed. A dead answer never blocks Add or Connect: the person
  // may know something the probe does not.
  useEffect(() => {
    if (!parsed) {
      setPrecheck({ state: "idle" });
      return;
    }
    const t = line.trim();
    let cancelled = false;
    const h = setTimeout(() => {
      setPrecheck({ state: "checking", line: t });
      checkLine(t)
        .then((result) => {
          if (cancelled) return;
          setPrecheck({ state: "done", line: t, result, verdict: verdictOf(result) });
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          const result: CheckResult = { input: t, alive: false, error: String(e) };
          setPrecheck({ state: "done", line: t, result, verdict: verdictOf(result) });
        });
    }, PRECHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, recheck]);

  // A change made from the tray icon shows here too.
  useEffect(() => {
    let off: (() => void) | undefined;
    void onRelayChanged(() => {
      void connectStatus().then(setStatus).catch(() => {});
    }).then((u) => (off = u));
    return () => off?.();
  }, []);

  /** Connect to a place. `knownLists` is for a list saved in the same click,
      which this render's `lists` does not hold yet. */
  const start = async (t: Target, knownLists: SavedList[] = lists) => {
    const source = sourceOfTarget(t, knownLists);
    if (typeof source === "string") {
      setError(source);
      return;
    }
    setBusy("connecting");
    setError(null);
    try {
      appliedProbe.current = probeUrl;
      const s = await connectStart(source, useSystem, listen.trim() || undefined, probeUrl);
      lastHealthAt.current = 0;
      connectedLine.current = t.kind === "fixed" ? t.line.trim() : null;
      setConnected(t);
      setStatus(s);
      const at = Date.now();
      if (t.kind === "fixed") {
        const l = t.line.trim();
        setSaved((list) => {
          let next = remember(list, l, at);
          if (precheck.state === "done" && precheck.line === l) next = withVerdict(next, l, savedVerdictOf(precheck.result, at));
          return next;
        });
      }
      if (t.kind === "list") setLists((ls) => listUsed(ls, t.id, at));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const stop = async () => {
    setBusy("stopping");
    setError(null);
    try {
      const s = await connectStop();
      connectedLine.current = null;
      setConnected(null);
      setStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const rotate = async () => {
    setBusy("rotating");
    setError(null);
    try {
      setStatus(await connectRotate());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const probe = async () => {
    setBusy("probing");
    setError(null);
    try {
      setStatus(await connectProbe());
      setLeakRun((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const copy = async () => {
    if (!status?.listen) return;
    await copyText(status.listen);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const pick = (t: Target) => {
    setTarget(t);
    setError(null);
  };
  const connectTo = (t: Target) => {
    pick(t);
    void start(t);
  };

  /* The switch: off → connect to the place picked; nothing picked → the
     field to paste one; on → disconnect. */
  const toggle = () => {
    if (running) return void stop();
    if (target) return void start(target);
    setTab("proxies");
    lineRef.current?.focus();
  };

  const addLine = () => {
    const t = line.trim();
    if (!parsed || !t) return;
    const at = Date.now();
    setSaved((list) => {
      let next = addSaved(list, t, at);
      if (precheck.state === "done" && precheck.line === t) next = withVerdict(next, t, savedVerdictOf(precheck.result, at));
      return next;
    });
    pick({ kind: "fixed", line: t });
    setLine("");
  };

  const addMany = (lines: string[]) => {
    setSaved((list) => addManySaved(list, lines));
    if (lines[0]) pick({ kind: "fixed", line: lines[0] });
  };

  const listFromLines = (lines: string[]) => {
    const l = makeList(freeListName(lists, `Pasted ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`), lines, "every_connection", undefined);
    setLists((ls) => upsertList(ls, l));
    pick({ kind: "list", id: l.id });
    setTab("lists");
  };

  /* Test all: every saved proxy checked again, four at a time, each row's
     verdict updated as its answer lands, the way Clash tests its nodes. */
  const testAll = async () => {
    const all = saved.map((p) => p.line);
    if (!all.length) return;
    let done = 0;
    setTesting({ done, total: all.length });
    const queue = [...all];
    const work = async () => {
      while (queue.length) {
        const l = queue.shift()!;
        try {
          const r = await checkLine(l);
          setSaved((list) => withVerdict(list, l, savedVerdictOf(r, Date.now())));
        } catch {
          /* an unreadable line keeps its last verdict */
        }
        done += 1;
        setTesting({ done, total: all.length });
      }
    };
    await Promise.all([work(), work(), work(), work()]);
    setTesting(null);
  };

  const forgetProxy = (p: SavedProxy) => {
    setSaved((l) => forget(l, p.id));
    if (target?.kind === "fixed" && target.line.trim() === p.line) setTarget(null);
  };
  const forgetAList = (l: SavedList) => {
    setLists((ls) => forgetList(ls, l.id));
    if (target?.kind === "list" && target.id === l.id) setTarget(null);
  };
  /** Save a list and pick it; with `connect`, connect through it at once. */
  const saveAList = (l: SavedList, connect = false) => {
    setLists((ls) => upsertList(ls, l));
    const t: Target = { kind: "list", id: l.id };
    pick(t);
    if (connect) void start(t, upsertList(lists, l));
  };

  const changeTarget = () => {
    setTab(tabOf(target));
    destRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  /* What the card says about the place: from the pick, or, when the relay was
     already running when this screen opened, from what the relay reports. */
  const view: TargetView | null = (() => {
    const t = running && connected ? connected : target;
    if (t?.kind === "fixed") {
      const s = saved.find((p) => p.line === t.line.trim());
      const parts = lineParts(t.line);
      return {
        kind: "fixed",
        name: parts.address,
        cc: s?.last?.cc,
        sub: [
          parts.user ? `login ${parts.user}` : "no login",
          s?.last ? (s.last.ok ? (s.last.latencyMs != null ? `${s.last.latencyMs} ms when last checked` : "working") : "did not answer last time") : undefined,
          s?.last?.place,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }
    if (t?.kind === "list") {
      const l = lists.find((x) => x.id === t.id);
      if (l) return { kind: "list", name: l.name, sub: `${l.lines.length} ${l.lines.length === 1 ? "proxy" : "proxies"}, ${ruleWords(l.rule, l.n)}` };
    }
    if (t?.kind === "free") {
      const proto = t.socks5 ? "SOCKS5" : "HTTP";
      if (t.exit) {
        // The relay swaps a free proxy that dies, and "new IP" swaps it too:
        // while connected, the card says when the one in use is another.
        const inUse = running && status?.source?.kind === "pool" ? addressInUse(status.source.in_use) : null;
        const where = countryName(t.exitCountry);
        return {
          kind: "free",
          name: `Free · ${t.exit}`,
          cc: t.exitCountry?.toLowerCase(),
          sub:
            inUse && inUse !== t.exit
              ? `Now through ${inUse}, swapped in for the one you picked`
              : `A public ${proto} proxy${where ? ` in ${where}` : ""}, swapped if it stops`,
        };
      }
      return {
        kind: "free",
        name: t.country ? `Free · ${freeCountryName(t.country)}` : "Free · fastest anywhere",
        cc: t.country ? t.country.toLowerCase() : undefined,
        sub: `A public ${proto} exit, swapped for a fresh one when it dies`,
      };
    }
    if (running && status?.source) {
      const s = status.source;
      return {
        kind: s.kind === "pool" ? "free" : s.kind,
        name: s.kind === "pool" ? "Free proxy" : s.kind === "list" ? `A list of ${s.size ?? "your"} proxies` : s.in_use,
        sub: s.kind === "pool" ? (s.detail ?? undefined) : s.kind === "list" ? (s.rotation ?? undefined) : undefined,
      };
    }
    return null;
  })();

  const failing = running && !!status?.health && !status.health.ok;
  const phase: Phase =
    busy === "connecting" ? "connecting" : busy === "stopping" ? "leaving" : busy === "rotating" ? "rotating" : running ? "on" : "off";
  const support = status?.support;
  const verdict = precheck.state === "done" && precheck.line === line.trim() ? precheck.verdict : null;

  // The fraud score of the address you appear as (Settings, Fraud score): once
  // per new exit, from the session's scores when it was asked before.
  const exitIp = phase === "on" && status?.health?.ok ? (status.health.exit_ip ?? null) : null;
  const [exitFraud, setExitFraud] = useState<FraudRow | null>(null);
  const { fraudOnConnect, fraudService, fraudKeys } = settings;
  useEffect(() => {
    if (!exitIp || !fraudOnConnect) {
      setExitFraud(null);
      return;
    }
    const known = cachedScore(fraudService, exitIp);
    setExitFraud(known ?? null);
    if (known) return;
    let live = true;
    void fraudScores([exitIp], fraudService, fraudKeys).then((found) => {
      if (live) setExitFraud(found.get(exitIp) ?? null);
    });
    return () => {
      live = false;
    };
  }, [exitIp, fraudOnConnect, fraudService, fraudKeys]);

  // The DNS leak test: once per exit (a new address is a new test) and again
  // after "Test now". Which resolver the proxy looks names up with, and where.
  const [dnsLeak, setDnsLeak] = useState<DnsLeak | null>(null);
  const [leakRun, setLeakRun] = useState(0);
  useEffect(() => {
    setDnsLeak(null);
    if (!exitIp) return;
    let live = true;
    void leakDns()
      .then((found) => live && setDnsLeak(found))
      .catch((e: unknown) => live && setDnsLeak({ state: "unavailable", why: String(e) }));
    return () => {
      live = false;
    };
  }, [exitIp, leakRun]);

  // The leak check's lines, while connected and the last check answered. The
  // clock is read on every render (once a second while connected), so the
  // line follows the zone as the browsers see it.
  const health = status?.health;
  const leaks: LeakRow[] | null =
    phase === "on" && health?.ok
      ? [
          dnsRow(dnsLeak, health.country_code),
          webrtcRow(isMobile()),
          timezoneRow(zone?.preview_clock ?? localTimeZone(), health.timezone, new Date(now), zone),
          languageRow(navigator.languages?.length ? navigator.languages : [navigator.language], health.country_code),
        ]
      : null;

  const onLeakAction = (a: LeakAction) => {
    if (a === "extension") return void openExternal(EXTENSION_PAGE);
    if (a === "date_time_settings") return void openExternal(DATE_TIME_SETTINGS);
    // The setting, as in Settings: App.tsx hands it to the Rust side, which
    // matches at once.
    if (a === "match_zone") return onSettings({ matchTimeZone: true });
    void zoneMatchAgain()
      .then(setZone)
      .catch((e: unknown) => setError(String(e)));
  };

  return (
    // overflow-x-hidden: nothing on this page may make it scroll sideways (the
    // connected looks' art is wider than the card, clipped to it).
    <div
      className="relative h-full overflow-y-auto overflow-x-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragActive) setDragActive(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void file.text().then(takeText);
        else takeText(e.dataTransfer.getData("text"));
      }}
    >
      <div className="mx-auto grid max-w-[1180px] items-start gap-4 px-6 pb-8 pt-1.5 max-sm:px-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-1.5">
          <ConnectionCard
            phase={phase}
            look={settings.connectLook}
            hub={settings.hubStyle}
            fraud={exitFraud}
            leaks={leaks}
            onLeakAction={onLeakAction}
            failing={failing}
            status={status}
            view={view}
            now={now}
            busy={busy !== ""}
            onToggle={toggle}
            canConnect={!!target}
            onChangeTarget={changeTarget}
            onRotate={() => void rotate()}
            onProbe={() => void probe()}
            onCopy={() => void copy()}
            copied={copied}
            error={error}
            useSystem={useSystem}
            setUseSystem={setUseSystem}
            canAutomate={support?.kind === "automatic"}
            manualWhy={support?.kind === "manual" ? support.why : undefined}
            manualSteps={support?.kind === "manual" ? support.steps : undefined}
            advanced={advanced}
            setAdvanced={setAdvanced}
            listen={listen}
            setListen={setListen}
          />
          {!isTauri() && (
            <p className="px-1 text-[12.5px] font-medium text-ink-soft">Browser preview: the relay is pretend here. The desktop app does it for real.</p>
          )}
        </div>

        <div ref={destRef} className="min-w-0 scroll-mt-2">
          <Destinations
            tab={tab}
            setTab={setTab}
            target={target}
            connected={connected}
            running={running}
            busy={busy !== ""}
            now={now}
            onPick={pick}
            onConnect={connectTo}
            lineRef={lineRef}
            saved={saved}
            line={line}
            setLine={setLine}
            lineState={{ parsed, parseError, checking: precheck.state === "checking", verdict }}
            onAdd={addLine}
            onAddMany={addMany}
            onListFromLines={listFromLines}
            onRecheck={() => setRecheck((n) => n + 1)}
            onForget={forgetProxy}
            testing={testing}
            onTestAll={() => void testAll()}
            lists={lists}
            listsSaveFailed={listsSaveFailed}
            onSaveList={saveAList}
            onForgetList={forgetAList}
            onCheckList={(l) => onCheckLines?.(l.lines)}
            incoming={incoming}
            freeCountry={freeCountry}
            setFreeCountry={setFreeCountry}
            freeSocks5={freeSocks5}
            setFreeSocks5={setFreeSocks5}
          />
        </div>
      </div>
      {dragActive && (
        <div className="drop-veil" aria-hidden="true">
          <span>
            <Icon.drop className="h-7 w-7" />
            Drop your proxies: one becomes a saved proxy, a list opens the review
          </span>
        </div>
      )}
    </div>
  );
}

