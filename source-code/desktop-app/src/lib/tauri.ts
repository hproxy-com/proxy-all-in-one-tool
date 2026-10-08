/* The bridge to the Rust side. Every call degrades gracefully in a plain
   browser (vite dev / screenshots), where `isTauri()` is false — the UI then
   runs its seeded simulation instead of invoking the engine. */

import type { CheckResult } from "./checker";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** A phone build, Android or iOS. There are no window controls to draw and no
    in-app updater there: phones update through their store. */
export function isMobile(): boolean {
  return typeof navigator !== "undefined" && /Android|iPhone|iPad/i.test(navigator.userAgent);
}

/** Installed from the Microsoft Store (src-tauri/src/store.rs). The Store updates
    that copy, and "start with the computer" cannot reach Windows from inside its
    package, so the app neither looks for updates nor offers it. Asked once. */
let storeInstall: Promise<boolean> | null = null;
export function isStoreInstall(): Promise<boolean> {
  if (!isTauri() || isMobile()) return Promise.resolve(false);
  storeInstall ??= import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<boolean>("store_install"))
    .catch(() => false);
  return storeInstall;
}

/** The machine in the person's hand, in words: "this device" on a phone or a
    tablet, "this computer" everywhere else. Every sentence about what stays
    where says it through here, so a phone never reads "this computer".
    `capital` for the start of a sentence or a label. */
export function thisDevice(capital = false): string {
  const words = isMobile() ? "this device" : "this computer";
  return capital ? `T${words.slice(1)}` : words;
}

export type CheckArgs = {
  proxies: string[];
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  protocols?: string[];
  judgeHttpUrl?: string;
  livenessHttpsUrl?: string;
  /** Geo endpoint override. An EMPTY string switches geolocation off, which is
      what makes the run send nothing off the machine. Undefined = the default
      public API. */
  geoApiUrl?: string;
  /** "local" (default), "api" or "both". Anything the engine does not recognise
      falls back to local, so a typo can never quietly upload a list. */
  source?: "local" | "api" | "both";
  checkApiUrl?: string;
  /** Also test whether SOCKS5 proxies relay UDP. Costs one extra round trip
      per working proxy. */
  measureUdp?: boolean;
  /** Also pull a small payload through each working proxy and report Mbit/s. */
  measureSpeed?: boolean;
};

export type DonePayload = {
  total: number;
  alive: number;
  duration_ms: number;
  cancelled: boolean;
  /** Lines skipped because they were the same proxy in another spelling. */
  duplicates?: number;
  /** Lines that could not be read as a proxy at all. */
  invalid?: number;
  /** Where the adaptive governor settled. Your concurrency setting is a ceiling
      now, not a target: the engine climbs toward it while a direct canary to our
      own judge says your connection has headroom, and backs off when it starts
      queueing. A peak well under the ceiling means we throttled to protect your
      line, which is the honest explanation for a slower run. */
  peak_concurrency: number;
  /** Run-level messages: the API rate-limited us and part of the list fell back
      to local, a chunk failed, and so on. A silent fallback is worse than a slow
      run, because the user cannot tell the mode they picked is not the mode they
      got. Show these. */
  notices: string[];
};

/** Start a run. Results stream back via `onResult` / `onDone`. */
export async function startChecks(args: CheckArgs): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("check_proxies", {
    args: {
      proxies: args.proxies,
      concurrency: args.concurrency,
      timeout_ms: args.timeoutMs,
      retries: args.retries,
      protocols: args.protocols,
      judge_http_url: args.judgeHttpUrl,
      liveness_https_url: args.livenessHttpsUrl,
      geo_api_url: args.geoApiUrl,
      source: args.source,
      check_api_url: args.checkApiUrl,
      measure_udp: args.measureUdp,
      measure_speed: args.measureSpeed,
    },
  });
}

export async function cancelChecks(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("cancel_checks");
}

export async function onResult(cb: (r: CheckResult) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<CheckResult>("checker:result", (e) => cb(e.payload));
}

export async function onDone(cb: (d: DonePayload) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<DonePayload>("checker:done", (e) => cb(e.payload));
}

/** Where an address lives. The engine looks these up beside the check, in
    waves, and sends each wave as it lands, so a row that settled before its
    wave arrived still gets its flag. Same field names as a result row. */
export type GeoLabel = {
  ip: string;
  country_code?: string | null;
  country?: string | null;
  city?: string | null;
  asn?: number | null;
  asn_org?: string | null;
  is_datacenter?: boolean | null;
};

export async function onGeo(cb: (labels: GeoLabel[]) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<GeoLabel[]>("checker:geo", (e) => cb(e.payload));
}

/** Let the person pick a list; resolves to its text, or null when they close
    the dialog. The dialog opens on the Rust side and the window never names a
    path, so the window holds no file access of its own. In a browser, falls
    back to a hidden <input type=file>. */
export async function importProxyFile(): Promise<string | null> {
  if (!isTauri()) {
    return new Promise<string | null>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".txt,.csv,text/plain";
      input.onchange = () => {
        const f = input.files?.[0];
        if (!f) return resolve(null);
        f.text().then(resolve);
      };
      input.click();
    });
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("import_proxy_file");
}

/** Let the person save `content` somewhere; false when they close the dialog.
    Same rule: the save dialog opens on the Rust side. In a browser, falls back
    to a download. */
export async function exportTextFile(defaultName: string, content: string, mime = "text/plain"): Promise<boolean> {
  if (!isTauri()) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("export_text_file", { defaultName, content });
}

/** Open a URL in the user's real browser (never inside the app window). */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/* ── Connect: the relay and the system proxy ─────────────────────────────── */

export type ParsedLine = { host: string; port: number; auth: boolean; scheme?: string | null };

export type SystemProxySupport =
  | { kind: "automatic"; how: string }
  | { kind: "manual"; why: string; steps: string };

/** What to connect through. Mirrors `ConnectSource` on the Rust side. A free
    source with `exit` (host:port, picked from the Free tab's list) starts on
    that proxy; without it the relay tests the pool and takes the first that
    works. Either way another free proxy takes over when the one in use dies. */
export type ConnectSourceArg =
  | { kind: "fixed"; line: string }
  | { kind: "list"; lines: string[]; rotation: { rule: RotationRule; n?: number } }
  | { kind: "free"; country?: string | null; socks5: boolean; exit?: string };

/** One free proxy from the pool, not tested yet. Mirrors `FreeExit` in
    src-tauri/src/connect.rs. */
export type FreeExit = {
  host: string;
  port: number;
  /** Two-letter country code; empty when the pool does not know it. */
  country: string;
  city: string;
  /** The network it belongs to, as the pool names it. */
  network: string;
  /** The pool's own last measurement, from its server, not from here. */
  latency_ms?: number | null;
};

/** One free proxy tested from this computer. Mirrors `FreeTest`. */
export type FreeTest = { ok: boolean; ms?: number | null; why?: string | null };

export type RotationRule = "every_connection" | "every_n" | "random" | "on_failure";

/** The relay's live counters. */
export type RelayStats = {
  connections: number;
  active: number;
  failures: number;
  rotations: number;
  bytes_up: number;
  bytes_down: number;
};

/** What the last probe through the relay found: the round trip to our judge
    and the address the judge saw, with its place. */
export type RelayHealth = {
  ok: boolean;
  latency_ms?: number | null;
  exit_ip?: string | null;
  country_code?: string | null;
  country?: string | null;
  city?: string | null;
  asn_org?: string | null;
  /** The exit's IANA time zone, e.g. "Europe/Berlin", when known. */
  timezone?: string | null;
  error?: string | null;
  checked_at_ms: number;
  failures_in_a_row: number;
  /** The host the probe went to. */
  target: string;
  /** Whether that host can name the exit address: our judge and any Cloudflare
      trace page can, a plain page cannot. */
  reflects_exit: boolean;
};

export type SourceInfo = {
  kind: "fixed" | "list" | "pool";
  size?: number | null;
  /** The list's rotation rule as a sentence. */
  rotation?: string | null;
  /** The upstream in use, never with its password. */
  in_use: string;
  /** The pool's description of the exit: place and latency. */
  detail?: string | null;
  can_rotate: boolean;
};

export type ConnectStatus = {
  running: boolean;
  listen?: string | null;
  upstream?: string | null;
  system_proxy: boolean;
  support: SystemProxySupport;
  notice?: string | null;
  source?: SourceInfo | null;
  started_at_ms?: number | null;
  stats?: RelayStats | null;
  health?: RelayHealth | null;
};

/** Read one line the way the engine will. Rejects with the engine's sentence. */
export async function parseLine(line: string): Promise<ParsedLine> {
  if (!isTauri()) {
    const m = line.match(/^(?:\w+:\/\/)?(?:([^@\s]+)@)?([^:\s@]+):(\d{1,5})(?::([^:\s]+):(.+))?$/);
    if (!m) throw new Error("could not read the line. Try host:port or host:port:username:password.");
    return { host: m[2], port: Number(m[3]), auth: !!(m[1] || m[4]) };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ParsedLine>("parse_line", { line });
}

/** Check one proxy for real, with its location: the look before connecting.
    A dead proxy resolves with `alive: false`; only an unreadable line rejects. */
export async function checkLine(line: string): Promise<CheckResult> {
  if (!isTauri()) return (await import("./previewConnect")).demoCheckLine(line);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CheckResult>("check_line", { line });
}

/* In a browser there is no relay. The preview module plays one, so the screen
   can be looked at in every state; the app itself never loads it. */

export async function connectStart(
  source: ConnectSourceArg,
  systemProxy: boolean,
  listen?: string,
  probeUrl?: string,
): Promise<ConnectStatus> {
  if (!isTauri()) {
    // The real relay takes a moment to start and pass its first check; the
    // preview waits about as long, so the connecting state can be seen.
    const pretend = await import("./previewConnect");
    await pretend.pretendWait(1500);
    return pretend.demoConnectStart(source, systemProxy, probeUrl);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ConnectStatus>("connect_start", { source, listen: listen ?? null, systemProxy, probeUrl: probeUrl ?? null });
}

/** Point the running probe at another server (Settings, "Connect check").
    Empty means our judge. Runs one probe at once. */
export async function connectSetProbe(url: string): Promise<ConnectStatus> {
  if (!isTauri()) return (await import("./previewConnect")).demoConnectSetProbe(url);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ConnectStatus>("connect_set_probe", { url: url || null });
}

export async function connectStop(): Promise<ConnectStatus> {
  if (!isTauri()) {
    const pretend = await import("./previewConnect");
    await pretend.pretendWait(450);
    return pretend.demoConnectStop();
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ConnectStatus>("connect_stop");
}

export async function connectStatus(): Promise<ConnectStatus> {
  if (!isTauri()) return (await import("./previewConnect")).demoConnectStatus();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ConnectStatus>("connect_status");
}

/** The free proxies of a country (empty or null: anywhere), best first, not
    tested yet. Rejects with the pool's reason, such as a used-up quota. */
export async function freeList(country: string | null, socks5: boolean): Promise<FreeExit[]> {
  if (!isTauri()) return (await import("./previewConnect")).demoFreeList(country, socks5);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<FreeExit[]>("free_list", { country: country || null, socks5 });
}

/** Test one free proxy the way Connect uses it: HProxy's own HTTPS page
    through it, certificates checked, 10 seconds at most. A proxy that fails
    resolves with `ok: false` and the reason in words; it never rejects. */
export async function freeTest(host: string, port: number, socks5: boolean): Promise<FreeTest> {
  if (!isTauri()) return (await import("./previewConnect")).demoFreeTest(host, port);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<FreeTest>("free_test", { host, port, socks5 });
}

/** One resolver the DNS leak test saw. Mirrors `LeakResolver` in src-tauri/src/connect.rs. */
export type LeakResolver = {
  ip: string;
  country_code?: string | null;
  country?: string | null;
  city?: string | null;
  asn_org?: string | null;
  client_subnet?: string | null;
};

/** What the DNS leak test found through the relay. Mirrors `DnsLeakView`. */
export type DnsLeak =
  | { state: "seen"; resolvers: LeakResolver[] }
  | { state: "not_seen" }
  | { state: "unavailable"; why: string };

/** The DNS leak test through the running relay: which resolver the proxy
    looks names up with. Takes a few seconds; rejects only when not connected. */
export async function leakDns(): Promise<DnsLeak> {
  if (!isTauri()) return (await import("./previewConnect")).demoLeakDns();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DnsLeak>("leak_dns");
}

/* The computer's time zone, matched to the exit while connected (Settings,
   "Match my time zone to the exit"). src-tauri/src/timezone.rs does all of
   it, after each probe through the relay, so it works with this screen
   closed; the window only says whether the setting is on. */

/** Mirrors `ZoneStatus` in src-tauri/src/timezone.rs. */
export type ZoneStatus = {
  /** This computer can match its zone from here (Windows). */
  supported: boolean;
  /** The setting is on. */
  matching: boolean;
  /** The Windows zone we set, while matched ("Central Standard Time"). */
  matched?: string | null;
  /** When it was set (Unix ms): browsers take a moment to notice. */
  matched_at_ms?: number | null;
  /** "Set time zone automatically" is on: Windows may put its own zone back. */
  automatic: boolean;
  /** Why the last match did not happen, in words. */
  problem?: string | null;
  note?: string | null;
  /** The browser preview only: the zone its pretend clock shows. */
  preview_clock?: string | null;
};

/** The setting on or off. On: matched at once while connected; off: put back at once. */
export async function zoneSetMatching(on: boolean): Promise<ZoneStatus> {
  if (!isTauri()) return (await import("./previewConnect")).demoZoneSetMatching(on);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ZoneStatus>("timezone_set_matching", { on });
}

/** "Match again": after Windows or the person set another zone while connected. */
export async function zoneMatchAgain(): Promise<ZoneStatus> {
  if (!isTauri()) return (await import("./previewConnect")).demoZoneMatchAgain();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ZoneStatus>("timezone_match_again");
}

export async function zoneStatus(): Promise<ZoneStatus> {
  if (!isTauri()) return (await import("./previewConnect")).demoZoneStatus();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ZoneStatus>("timezone_status");
}

/** Switch to a different upstream: the next in the list, or a fresh free exit. */
export async function connectRotate(): Promise<ConnectStatus> {
  if (!isTauri()) return (await import("./previewConnect")).demoConnectRotate();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ConnectStatus>("connect_rotate");
}

/** One probe through the relay right now. */
export async function connectProbe(): Promise<ConnectStatus> {
  if (!isTauri()) return (await import("./previewConnect")).demoConnectProbe();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ConnectStatus>("connect_probe");
}

/** Copy text to the clipboard (works in the Tauri webview and the browser). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore — clipboard may be unavailable */
  }
}

/* ── In the background: the icon by the clock, starting with the computer ──
   (src-tauri/src/tray.rs). A plain browser and a phone have neither, so every
   call here is a no-op there. */

/** Closing the window keeps the app running in the tray while this is on. */
export async function setKeepRunning(enabled: boolean): Promise<void> {
  if (!isTauri() || isMobile()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_keep_running", { enabled });
}

/** The tray's "Connect": the window connects to the place picked last. */
export async function onTrayConnect(cb: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("tray-connect", () => cb());
}

/** The relay started or stopped, from the window or from the tray. */
export async function onRelayChanged(cb: (connected: boolean) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<boolean>("relay-changed", (e) => cb(!!e.payload));
}

/** Whether the app starts with the computer (off until the person ticks it).
    Never in the Microsoft Store copy (isStoreInstall). */
export async function startsWithComputer(): Promise<boolean> {
  if (!isTauri() || isMobile() || (await isStoreInstall())) return false;
  const { isEnabled } = await import("@tauri-apps/plugin-autostart");
  return isEnabled();
}

export async function setStartsWithComputer(on: boolean): Promise<void> {
  if (!isTauri() || isMobile() || (await isStoreInstall())) return;
  const { enable, disable } = await import("@tauri-apps/plugin-autostart");
  if (on) await enable();
  else await disable();
}

/* ── Fraud scores (src-tauri/src/fraud.rs) ─────────────────────────────── */

/** Look addresses up with a service (lib/fraud.ts builds `service`). Every
    address comes back, with a score or the sentence that says why not. */
export async function fraudLookup(
  ips: string[],
  service: Record<string, string>,
): Promise<{ ip: string; score: import("./fraud").FraudScore | null; error: string | null }[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("fraud_lookup", { ips, service });
}

/* ── Updates (src-tauri/src/update.rs, channel.rs, store.rs) ───────────── */

/** Where this copy came from, which is where its updates come from, as the
    system says it (src-tauri/src/channel.rs). The same names are in the version
    list on hproxy.com. */
export type Channel =
  | "windows"
  | "macos"
  | "linux-appimage"
  | "linux-deb"
  | "linux-rpm"
  | "microsoft-store"
  | "google-play"
  | "apk"
  | "app-store";

let channel: Promise<Channel | null> | null = null;
/** This copy's channel, asked once. Null in a plain browser. */
export function installChannel(): Promise<Channel | null> {
  if (!isTauri()) return Promise.resolve(null);
  channel ??= import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<Channel>("install_channel"))
    .catch(() => null);
  return channel;
}

/** A newer version, as the start screen and the title bar show it. */
export type UpdateInfo = {
  version: string;
  currentVersion: string;
  notes?: string | null;
  date?: string | null;
};

/** How far a download is. `total` is null when the server did not say. */
export type UpdateProgress = { downloaded: number; total: number | null };

/** What the start check did (src-tauri/src/update.rs, `AtStart`). Every
    outcome opens the app; an install ends it, and the new version opens. */
export type AtStart =
  | { outcome: "not-here" | "current" | "no-answer" }
  | { outcome: "waits" | "failed" | "tried-recently"; version: string };

/** The Microsoft Store copy's start check (src-tauri/src/store.rs). */
export type StoreAtStart = { outcome: "not-here" | "current" | "no-answer" | "not-installed" };

async function call<T>(command: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command);
}

export async function updateAtStart(): Promise<AtStart> {
  if (!isTauri() || isMobile()) return { outcome: "not-here" };
  return call<AtStart>("update_at_start");
}

export async function storeUpdateAtStart(): Promise<StoreAtStart> {
  if (!isTauri() || isMobile()) return { outcome: "not-here" };
  return call<StoreAtStart>("store_update_at_start");
}

/** Look for a newer version now. Null when there is none, or when this copy
    does not update itself (a store's copy, a package). */
export async function updateCheck(): Promise<UpdateInfo | null> {
  if (!isTauri() || isMobile()) return null;
  return call<UpdateInfo | null>("update_check");
}

/** Download the version the last look found, verified before it is kept. */
export async function updateDownload(): Promise<void> {
  return call<void>("update_download");
}

/** Install the downloaded version. On Windows this never returns. */
export async function updateInstall(): Promise<void> {
  return call<void>("update_install");
}

/** Forget the found version, so the next look fetches it afresh. */
export async function updateForget(): Promise<void> {
  if (!isTauri() || isMobile()) return;
  return call<void>("update_forget");
}

/** The start check's progress, as the Rust side reports it. */
export type UpdateEvents = {
  found?: (info: UpdateInfo) => void;
  progress?: (progress: UpdateProgress) => void;
  installing?: (version: string) => void;
  /** The Microsoft Store's own update window is open. */
  store?: () => void;
};

export async function onUpdateEvents(handlers: UpdateEvents): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const offs = await Promise.all([
    listen<UpdateInfo>("update:found", (e) => handlers.found?.(e.payload)),
    listen<UpdateProgress>("update:progress", (e) => handlers.progress?.(e.payload)),
    listen<string>("update:installing", (e) => handlers.installing?.(e.payload)),
    listen<null>("update:store", () => handlers.store?.()),
  ]);
  return () => offs.forEach((off) => off());
}

/** What the app knows about whether anybody is using it. `other_copies` is
    null when the running copies could not be counted (that counts as someone). */
export type UpdateIdle = { window_visible: boolean; connected: boolean; other_copies: number | null };

export async function updateIdle(): Promise<UpdateIdle | null> {
  if (!isTauri() || isMobile()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<UpdateIdle>("update_idle");
}

/** Install the newest version silently if nobody is using the app. False when
    there was nothing to do; on Windows a real install never returns. */
export async function updateInstallQuietly(): Promise<boolean> {
  if (!isTauri() || isMobile()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("update_install_quietly");
}

/** What an AI assistant's setup names to start this app as its tool with `mcp`
    (src-tauri/src/main.rs): `hproxy` where the tool's folder is on the user's
    PATH, else the program's full path (src-tauri/src/tool.rs). Null in a plain
    browser. */
export async function toolCommand(): Promise<string | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("tool_command");
}
