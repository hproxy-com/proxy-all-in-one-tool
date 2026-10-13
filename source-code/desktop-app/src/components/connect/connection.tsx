import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode, type RefObject } from "react";
import {
  connectBack,
  connectMember,
  connectProbe,
  connectRotate,
  connectSetProbe,
  connectStart,
  connectStop,
  copyText,
  isMobile,
  openExternal,
  placesGroupLines,
  zoneMatchAgain,
  type ConnectStatus,
} from "../../lib/tauri";
import type { Settings } from "../../lib/settings";
import { DEFAULT_ROTATION, listLines, spacedN } from "../../lib/connect";
import { phaseOf, placeView, type Busy } from "../../lib/connectionView";
import { freeGroupName, MAX_PROXIES, samePlace, tabOf, type GroupInput, type GroupView, type Place, type ProxyView } from "../../lib/places";
import { placesStore } from "../../lib/placesStore";
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
import type { View } from "../TitleBar";
import type { ConnectionCardProps } from "./ConnectionCard";
import type { DestinationsProps, DestTab } from "./Destinations";
import { useExitChecks } from "./useExitChecks";
import { useLineCheck } from "./useLineCheck";
import { usePasteAnywhere } from "./usePasteAnywhere";
import { useRelayStatus } from "./useRelayStatus";
import { useSavedChecks } from "./useSavedChecks";

/* The connection, for the whole app: one page for Connect, one page for the
   proxy list with the checker inside it, and the connection above both.
   Everything the Connect screen used to hold lives here, above the pages, so
   Connect (ConnectPanel.tsx) and Proxies (ProxiesPage.tsx) show the same
   connection, and moving between them, or to Settings, never loses a pasted
   line, a test that is running, or the relay's status.

   It works like a VPN app, connects through proxies, keeps saved places, and
   stays as smooth as possible. Under it, as before, a password-free proxy on
   this computer that forwards to the real one with the login attached, so
   every program can use it, and the system proxy set and put back exactly as
   found. Switching places while connected is one click and happens inside the
   running relay (src-tauri/src/connect.rs, switch_in_place): the port and the
   system proxy stay, the open connections move to the new place.

   The places themselves (saved proxies, groups, the pick) are the app's
   (src-tauri/src/places.rs), kept by lib/placesStore.ts for the window: this
   screen names a place by its id and never holds a password. A connect counts
   the use and remembers the pick on the Rust side, whether it came from here
   or from the tray.

   This file wires the pieces together; each lives in its own file:
   useRelayStatus (the relay's status, speed and time zone), useLineCheck (the
   paste field's line, read and probed), useExitChecks (fraud scores and the
   DNS leak test), useSavedChecks (Test all and one row's Check again),
   usePasteAnywhere (Ctrl+V on the page), and lib/connectionView.ts (what the
   card says). */

/** The Proxies page's tabs: the three kinds of place. The checker is a page of its own since
    2026-10-12 (CheckerPage.tsx). */
export type ProxiesPane = DestTab;

/** The day, for a new group's name: "3 Oct". */
const today = () => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** What to say when lines did not fit among the saved proxies. */
const noRoom = (left: number) =>
  `${spacedN(left)} ${left === 1 ? "proxy was" : "proxies were"} not saved: ${spacedN(MAX_PROXIES)} is the most. Remove some, or keep them as a group.`;

/** Whether the view holds a proxy or group the relay names (a free place always counts). */
function knows(place: Place, proxies: ProxyView[], groups: GroupView[]): boolean {
  if (place.kind === "proxy") return proxies.some((p) => p.id === place.id);
  if (place.kind === "group") return groups.some((g) => g.id === place.id);
  return true;
}

export type Connection = {
  /** The connection card's props, for whichever design lays out Connect. */
  card: ConnectionCardProps;
  /** The places, for the Proxies page. */
  destinations: DestinationsProps;
  pane: ProxiesPane;
  setPane: (p: ProxiesPane) => void;
  /** The Proxies page, on one of its tabs. */
  open: (p: ProxiesPane) => void;
  /** A proxy or a list dropped on a page. */
  drag: {
    active: boolean;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
  checkSeed: { text: string; at: number } | null;
  /** Connect's own paste field (Quick connect). */
  quickRef: RefObject<HTMLInputElement | null>;
  /** When something last asked for Connect's paste field (a proxy pasted on Connect, the
      switch pressed with nothing picked): Connect opens its places for it and the field
      takes the keyboard. 0 until then. */
  quickAsk: number;
  askQuick: () => void;
  /** Text pasted or dropped: one proxy fills a field, a list opens the review on Proxies. */
  takePasted: (text: string) => void;
  /** The Checker's "Connect through this": save the line, then connect through it on Connect. */
  connectThrough: (raw: string) => void;
  /** The Checker's "Save the working ones as a group". */
  saveAsGroup: (lines: string[]) => void;
  checkLines: (lines: string[]) => void;
};

const ConnectionContext = createContext<Connection | null>(null);

export function useConnection(): Connection {
  const c = useContext(ConnectionContext);
  if (!c) throw new Error("useConnection outside ConnectionProvider");
  return c;
}

export function ConnectionProvider({
  settings,
  onSettings,
  active,
  onConnectPage,
  setView,
  children,
}: {
  settings: Settings;
  /** Change a setting from here (the leak check's "Match it while connected"). */
  onSettings: (patch: Partial<Settings>) => void;
  /** Connect or Proxies is on screen: a paste anywhere is taken as a proxy. */
  active: boolean;
  /** Connect is the page on screen: one proxy pasted there stays there. */
  onConnectPage: boolean;
  setView: (v: View) => void;
  children: ReactNode;
}) {
  // The places, as the app keeps them: read at start (moving the window's old
  // storage in the first time), then again after every change, every connect
  // (the tray's too) and every probe through a saved proxy.
  const places = useSyncExternalStore(placesStore.subscribe, placesStore.snapshot);
  useEffect(() => void placesStore.start(), []);
  const { proxies, groups } = places.view;
  const picked = places.view.picked ?? null;
  /* A problem with the last change to the places (no room, a group none of
     whose lines can be read), shown on the Proxies page until the next change
     goes through. */
  const [placesProblem, setPlacesProblem] = useState<string | null>(null);

  /* The list opens on My proxies, whatever was picked last: the app is for
     people connecting proxies of their own, and free proxies are the extra. The place picked last stays remembered for the
     switch, and "Change" on the card opens its tab. */
  const [pane, setPane] = useState<ProxiesPane>("proxies");
  const tab: DestTab = pane;
  // The Free tab opens on the country and protocol of a free place picked
  // last, once the places are read.
  const [freeSocks5, setFreeSocks5] = useState(false);
  const [freeCountry, setFreeCountry] = useState("");
  const freeFromPick = useRef(false);
  useEffect(() => {
    if (!places.ready || freeFromPick.current) return;
    freeFromPick.current = true;
    if (picked?.kind === "free") {
      setFreeSocks5(picked.socks5);
      setFreeCountry(picked.country);
    }
  }, [places.ready, picked]);

  const [line, setLine] = useState("");
  const lineCheck = useLineCheck(line);
  const { testing, checkingIds, checkSaved, testAll } = useSavedChecks(proxies);
  /* The place the last connect failed on, and why: the Proxies page shows it
     on that place's row, since a click there connects without leaving the
     page (the card on Connect says it too). */
  const [failed, setFailed] = useState<{ place: Place; words: string } | null>(null);

  const [useSystem, setUseSystem] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [listen, setListen] = useState("");
  const { status, setStatus, running, connected, zone, setZone, rate, now } = useRelayStatus();
  /** The place a connect is under way to, while it is. */
  const [goingTo, setGoingTo] = useState<Place | null>(null);
  /** The member of a group being moved to, while that is under way. */
  const [goingToMember, setGoingToMember] = useState<number | null>(null);
  const [busy, setBusy] = useState<Busy>("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [incoming, setIncoming] = useState<{ text: string; at: number } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const lineRef = useRef<HTMLInputElement>(null);
  const quickRef = useRef<HTMLInputElement>(null);
  const [quickAsk, setQuickAsk] = useState(0);
  const askQuick = () => setQuickAsk(Date.now());
  const takeText = (text: string) => {
    if (!text.trim()) return;
    // One proxy pasted or dropped on Connect goes into Connect's own field, checked at once,
    // and you stay where the switch is: its Connect, or Enter, connects through it. (It
    // used to send you to the Proxies page, where Add only saved it.)
    if ((onConnectPage || quickRef.current) && listLines(text).length < 2) {
      setLine(text.trim());
      askQuick();
      return;
    }
    // On Groups a paste starts a group there; anywhere else it goes to My proxies.
    setPane((cur) => (cur === "groups" ? "groups" : "proxies"));
    setIncoming({ text, at: Date.now() });
    // The field and the review are on the Proxies page.
    setView("proxies");
  };
  usePasteAnywhere(active, takeText);

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

  // A probe through a saved proxy is the freshest word on it: the app keeps
  // it with the proxy (src-tauri/src/connect.rs, took_probe), and its row
  // reads it again here.
  const lastHealthAt = useRef<number>(0);
  const connectedKind = connected?.kind;
  useEffect(() => {
    const h = status?.health;
    if (!running || !h || connectedKind !== "proxy" || h.checked_at_ms === lastHealthAt.current) return;
    lastHealthAt.current = h.checked_at_ms;
    void placesStore.refresh().catch(() => {});
  }, [status, running, connectedKind]);

  // The relay names a place this window has not seen (made a moment ago in
  // another door, or the browser preview's sample): read the places again.
  const strange = !!connected && places.ready && !knows(connected, proxies, groups);
  useEffect(() => {
    if (strange) void placesStore.refresh().catch(() => {});
  }, [strange]);

  /** Connect to a place, or move there while connected; a group starts on
      `member` when one is given. The app counts the use and makes it the
      pick; a place that failed stays the pick, so the switch tries it again. */
  const start = async (place: Place, member?: number) => {
    setBusy(running ? "switching" : "connecting");
    setGoingTo(place);
    setGoingToMember(member ?? null);
    setError(null);
    setFailed(null);
    try {
      appliedProbe.current = probeUrl;
      lastHealthAt.current = 0;
      setStatus(await connectStart(place, useSystem, listen.trim() || undefined, probeUrl, member));
    } catch (e) {
      const words = String(e);
      setError(words);
      setFailed({ place, words });
      if (!samePlace(place, picked)) void placesStore.pick(place).catch(() => {});
    } finally {
      setBusy("");
      setGoingTo(null);
      setGoingToMember(null);
    }
  };

  const stop = async () => {
    setBusy("stopping");
    setError(null);
    try {
      setStatus(await connectStop());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  /** A move within the place connected through: New IP, Back, a member
      picked. The connection stays up; only the exit behind it changes. */
  const moveWithin = async (move: () => Promise<ConnectStatus>) => {
    setBusy("rotating");
    setError(null);
    try {
      lastHealthAt.current = 0;
      setStatus(await move());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
      setGoingToMember(null);
    }
  };

  /** A member of a group, picked from its list: within the connection when
      it runs through that group, else a connect that starts on it. */
  const connectToMember = (groupId: string, member: number) => {
    const place: Place = { kind: "group", id: groupId };
    if (running && samePlace(connected, place)) {
      setGoingToMember(member);
      return void moveWithin(() => connectMember(member));
    }
    void start(place, member);
  };

  const probe = async () => {
    setBusy("probing");
    setError(null);
    try {
      setStatus(await connectProbe());
      retestDns();
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

  /** Make a place the pick without connecting: the switch connects to it. */
  const pickPlace = (place: Place) => placesStore.pick(place).catch((e: unknown) => setPlacesProblem(String(e)));
  const connectTo = (place: Place) => void start(place);

  /* The switch: off → connect to the place picked; nothing picked → the
     field to paste one (Connect's own, with your places and the fastest free
     proxy beside it; else on Proxies); on → disconnect. */
  const toggle = () => {
    if (running) return void stop();
    if (picked) return void start(picked);
    if (onConnectPage || quickRef.current) return void askQuick();
    setPane("proxies");
    setView("proxies");
    setTimeout(() => lineRef.current?.focus(), 60);
  };

  /** Save lines as proxies and pick the first; says so when some did not fit.
      The id of the first, when one was saved. */
  const saveProxies = async (lines: string[]): Promise<string | undefined> => {
    try {
      const ids = await placesStore.add(lines);
      const left = new Set(lines.map((l) => l.trim()).filter(Boolean)).size - ids.length;
      setPlacesProblem(left > 0 ? noRoom(left) : null);
      if (ids[0]) await pickPlace({ kind: "proxy", id: ids[0] });
      return ids[0];
    } catch (e) {
      setPlacesProblem(String(e));
      return undefined;
    }
  };

  /** The paste field's Add: save the line and pick it. */
  const addLine = async () => {
    const t = line.trim();
    if (!lineCheck.parsed || !t) return;
    if (await saveProxies([t])) setLine("");
  };

  /** Connect's paste field: save the line and connect through it at once (moving there
      while connected). The line is kept in My proxies like any other. */
  const addAndConnect = async () => {
    const t = line.trim();
    if (!lineCheck.parsed || !t) return;
    const id = await saveProxies([t]);
    if (!id) return;
    setLine("");
    void start({ kind: "proxy", id });
  };

  /** Lines kept as one new group, named after `base` and the day, and picked. */
  const makeGroup = async (base: string, lines: string[]): Promise<boolean> => {
    try {
      const id = await placesStore.saveGroup({ name: freeGroupName(groups, `${base} ${today()}`), lines, rule: DEFAULT_ROTATION });
      setPlacesProblem(null);
      await pickPlace({ kind: "group", id });
      return true;
    } catch (e) {
      setPlacesProblem(String(e));
      return false;
    }
  };

  /** A group saved from its editor, and picked; with `connect`, connected
      through at once. Rejects with the app's words, which the editor shows. */
  const saveGroup = async (input: GroupInput, connect = false) => {
    const id = await placesStore.saveGroup(input);
    setPlacesProblem(null);
    const place: Place = { kind: "group", id };
    if (connect) void start(place);
    else await pickPlace(place);
  };


  const changed = (p: Promise<unknown>) =>
    void p.then(
      () => setPlacesProblem(null),
      (e: unknown) => setPlacesProblem(String(e)),
    );
  const forgetProxy = (p: ProxyView) => changed(placesStore.forget(p.id));
  const renameProxy = (p: ProxyView, name: string) => changed(placesStore.rename(p.id, name));
  const forgetGroup = (g: GroupView) => changed(placesStore.forgetGroup(g.id));

  // "Change" on the card: the Proxies page, on the tab of the place picked.
  const changePlace = () => {
    setPane(tabOf(picked));
    setView("proxies");
  };

  /* The checker's hand-overs (Proxies, Checker): one proxy to connect
     through (saved, then connected on Connect, where the map shows it; it
     used to stop at picking it, under a button that says Connect), the
     working ones kept as a group, or lines to check. */
  const connectThrough = (raw: string) =>
    void saveProxies([raw.trim()]).then((id) => {
      if (!id) return;
      setView("connect");
      void start({ kind: "proxy", id });
    });
  const saveAsGroup = (lines: string[]) =>
    void makeGroup("Working", lines).then((made) => {
      if (made) setView("connect");
    });
  const [checkSeed, setCheckSeed] = useState<{ text: string; at: number } | null>(null);
  const checkLines = (lines: string[]) => {
    setCheckSeed({ text: lines.join("\n"), at: Date.now() });
    setView("checker");
  };
  /** A group's members in the Checker: its lines are read from the app for that. */
  const checkGroup = (g: GroupView) =>
    void placesGroupLines(g.id)
      .then(checkLines)
      .catch((e: unknown) => setPlacesProblem(String(e)));

  /* What the card says about the place: the one a connect is under way to,
     else the one the relay goes through, else the pick. */
  const shown: Place | null = goingTo ?? connected ?? picked;
  const view = placeView(shown, { proxies, groups, status, connected });

  const failing = running && !!status?.health && !status.health.ok;
  const phase = phaseOf(busy, running);
  const support = status?.support;

  // The address you appear as, while on and the last probe answered.
  const exitIp = phase === "on" && status?.health?.ok ? (status.health.exit_ip ?? null) : null;
  const { exitFraud, dnsLeak, retestDns } = useExitChecks(exitIp, settings);

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

  // The connection's props and the list of places, for whichever design
  // lays out the page (Settings, "Connect page"; lib/look.ts CONNECT_DESIGNS).
  const card: ConnectionCardProps = {
    phase,
    look: settings.connectLook,
    hub: settings.hubStyle,
    fraud: exitFraud,
    leaks,
    onLeakAction,
    failing,
    status,
    rate,
    view,
    now,
    busy: busy !== "",
    onToggle: toggle,
    canConnect: !!picked,
    onChangeTarget: changePlace,
    onRotate: () => void moveWithin(connectRotate),
    onBack: running && status?.source?.kind === "list" && (status.source.size ?? 0) > 1 ? () => void moveWithin(connectBack) : undefined,
    onProbe: () => void probe(),
    onCopy: () => void copy(),
    copied,
    error,
    useSystem,
    setUseSystem,
    canAutomate: support?.kind === "automatic",
    manualWhy: support?.kind === "manual" ? support.why : undefined,
    manualSteps: support?.kind === "manual" ? support.steps : undefined,
    advanced,
    setAdvanced,
    listen,
    setListen,
  };
  const destinations: DestinationsProps = {
    tab,
    setTab: setPane,
    picked,
    connected,
    running,
    busy: busy !== "",
    goingTo,
    goingToMember,
    memberInUse: running && connected?.kind === "group" ? (status?.source?.member ?? null) : null,
    onConnectMember: connectToMember,
    problem: failed,
    now,
    onConnect: connectTo,
    lineRef,
    ready: places.ready,
    note: placesProblem ?? places.notice,
    proxies,
    line,
    setLine,
    lineState: { parsed: lineCheck.parsed, parseError: lineCheck.parseError, checking: lineCheck.checking, verdict: lineCheck.verdict },
    onAdd: () => void addLine(),
    onAddAndConnect: () => void addAndConnect(),
    onAddMany: (lines) => void saveProxies(lines),
    onGroupFromLines: (lines) =>
      void makeGroup("Pasted", lines).then((made) => {
        if (made) setPane("groups");
      }),
    onRecheck: lineCheck.recheck,
    onForget: forgetProxy,
    onRename: renameProxy,
    checkingIds,
    onCheckOne: (p) => void checkSaved(p.id),
    testing,
    onTestAll: () => void testAll(),
    groups,
    onSaveGroup: saveGroup,
    onForgetGroup: forgetGroup,
    onCheckGroup: checkGroup,
    onCheckLines: checkLines,
    incoming,
    freeCountry,
    setFreeCountry,
    freeSocks5,
    setFreeSocks5,
  };
  const drag: Connection["drag"] = {
    active: dragActive,
    onDragOver: (e) => {
      e.preventDefault();
      if (!dragActive) setDragActive(true);
    },
    onDragLeave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDragActive(false);
    },
    onDrop: (e) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void file.text().then(takeText);
      else takeText(e.dataTransfer.getData("text"));
    },
  };

  const open = (p: ProxiesPane) => {
    setPane(p);
    setView("proxies");
  };

  const value: Connection = {
    card,
    destinations,
    pane,
    setPane,
    open,
    drag,
    checkSeed,
    quickRef,
    quickAsk,
    askQuick,
    takePasted: takeText,
    connectThrough,
    saveAsGroup,
    checkLines,
  };
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}
