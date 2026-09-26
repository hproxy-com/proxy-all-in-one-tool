/* Persistent user settings (localStorage). Defaults are the gentle,
   network-friendly ones. */

import { DEFAULT_FRAUD_SERVICE, isFraudService, type FraudKeys, type FraudServiceId } from "./fraud";
import {
  DEFAULT_BACKGROUND,
  DEFAULT_CONNECT_LOOK,
  DEFAULT_HUB_STYLE,
  isBackground,
  isConnectLook,
  isHubStyle,
  type Background,
  type ConnectLook,
  type HubStyle,
} from "./look";
import { thisDevice } from "./tauri";

export type Protocols = { http: boolean; https: boolean; socks4: boolean; socks5: boolean };

export type Settings = {
  /** Proxies checked at once. Gentle default; the Settings slider warns past a
      safe point (a home router chokes on connections long before the CPU does). */
  concurrency: number;
  /** Per-proxy timeout in milliseconds. */
  timeoutMs: number;
  /** Extra attempts after the first failure. */
  retries: number;
  protocols: Protocols;
  /** Look up country / city / ASN / ISP for each proxy.
   *
   *  The IP addresses being checked go to HProxy's free IP API in batches of 100
   *  (not the ports, not the credentials, not the results). The location and ISP
   *  columns go blank when it is off and everything else behaves identically.
   *
   *  ⚠️ This used to be documented as "the ONE thing that sends anything off the
   *  machine". That has not been true since `source` gained API modes: turning
   *  geo off only makes the app self-contained when `source` is `"local"` too.
   *  Keep this, the Settings copy, and the README's "What leaves your machine"
   *  table saying the same thing. */
  geoLookup: boolean;
  /** Who does the checking.
   *
   *  `local` (the default) opens every connection from here. Nothing about the
   *  proxies is transmitted, and it is the only mode that returns the full
   *  detail: timing breakdown, exit address, leaked headers, software, HTTPS
   *  interception. It is also the only mode that tells the truth about a proxy
   *  locked to this computer's IP address, which every other machine sees as
   *  dead. The default since 2026-09-19, as asked on 2026-07-23: "checking
   *  through the PC by default, but can also use our API to speed up".
   *
   *  `both` splits the list across HProxy's servers and this machine over one
   *  shared queue, so whichever side is quicker gets through more of it: your
   *  own address is not the one hitting every proxy, your line is not
   *  saturated, and a big list finishes sooner.
   *
   *  `api` puts all of it on our hardware. Your machine makes one request and
   *  reads a stream. The server-side verifier does not measure the detail
   *  above, so API rows carry `source: "api"` and the interface says which
   *  engine produced each row.
   *
   *  ⚠️ Anything that reaches our servers includes credentials, so the README's
   *  "What leaves your machine" table has to agree with whatever this default
   *  is. Change one and change the other. */
  source: "local" | "api" | "both";
  theme: "electric" | "midnight";
  /** The page behind everything: Aura by default (lib/look.ts). */
  background: Background;
  /** How the connection card looks while connected (lib/look.ts, CONNECT_LOOKS). */
  connectLook: ConnectLook;
  /** The H in the middle of the card's route: a button, a switch, or the small sign (lib/look.ts, HUB_STYLES). */
  hubStyle: HubStyle;
  /** Closing the window keeps the app in the tray by the clock, connection
      and all (src-tauri/src/tray.rs). On by default: a VPN keeps running when
      its window closes, and so does this. */
  keepRunning: boolean;
  /** Where the Connect screen's probe goes while connected. See PROBE_PRESETS. */
  connectProbeUrl: string;
  /** Also ask every working SOCKS5 proxy to relay UDP. One more round trip each. */
  measureUdp: boolean;
  /** Also pull a small payload through every working proxy and report Mbit/s. */
  measureSpeed: boolean;
  /** Who gives fraud scores (lib/fraud.ts): FFraud's free lookup by default,
      or a service the person has a key for. The address being scored goes to
      that service from this computer, nowhere else. */
  fraudService: FraudServiceId;
  /** The keys given, per service, kept on this computer only. */
  fraudKeys: FraudKeys;
  /** Look up the address you appear as while connected (Connect's card). */
  fraudOnConnect: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  concurrency: 64,
  timeoutMs: 8000,
  retries: 0,
  protocols: { http: true, https: true, socks4: true, socks5: true },
  geoLookup: true,
  source: "local",
  // White by default, in the extension and the app; dark is one click in
  // the title bar.
  theme: "electric",
  // Aura; the rest are in Settings.
  background: DEFAULT_BACKGROUND,
  connectLook: DEFAULT_CONNECT_LOOK,
  hubStyle: DEFAULT_HUB_STYLE,
  keepRunning: true,
  connectProbeUrl: "https://hproxy.com/api/free-proxy/echo",
  measureUdp: false,
  measureSpeed: false,
  fraudService: DEFAULT_FRAUD_SERVICE,
  fraudKeys: {},
  fraudOnConnect: true,
};

/** Where the Connect screen's probe goes while connected. Our judge by default,
    because it is the only target that can say which address you appear as. */
export const DEFAULT_PROBE_URL = "https://hproxy.com/api/free-proxy/echo";

/** `[url, name, what it can tell you]`. Anything else is typed in as custom. */
export const PROBE_PRESETS: readonly (readonly [string, string, string])[] = [
  [DEFAULT_PROBE_URL, "HProxy judge", "names the address you appear as"],
  ["https://www.google.com/generate_204", "Google", "reachability and round trip"],
  ["https://www.cloudflare.com/cdn-cgi/trace", "Cloudflare", "also names the address you appear as"],
];

/** What the engine should use as its geo endpoint for a run. An empty string is
    the engine's documented "geolocation off" signal. */
export function geoApiUrl(s: Settings): string | undefined {
  return s.geoLookup ? undefined : "";
}

/** One sentence on what a check sends off this computer, for the Check tab's
    welcome. It follows the settings, because a privacy line that is true only
    for the defaults is a false one after a click (the Settings hints and the
    README's "What leaves your machine" say the same). */
export function whatLeaves(s: Pick<Settings, "source" | "geoLookup">): string {
  if (s.source !== "local") return "Checking also runs on HProxy's servers (Settings, Where checking runs), so your list goes there, logins included.";
  if (s.geoLookup) return `Checked from ${thisDevice()}: your list and its logins stay here. Only the addresses go out, to show where each one is, and Settings turns that off.`;
  return `Checked from ${thisDevice()}, and nothing about your list leaves it.`;
}

/** Above this the UI warns that a home connection may struggle. */
export const GENTLE_CONCURRENCY_CEILING = 250;
export const MAX_CONCURRENCY = 1000;

const KEY = "hproxy-checker-settings";

/* Settings saved before 2026-09-23 carry no `look`. Their theme is the old
   default (midnight) saved on first run, not a choice anyone made: the app
   saves the defaults the moment it opens. So once, on the way in, they move to
   white, the default for both the extension and the app. Anyone who wants
   dark after that picks it again,
   and it stays, because from then on the settings carry `look`. */
const LOOK = "d-2026-09-23";
type Stored = Partial<Settings> & { look?: string };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Stored;
      const theme = parsed.look === LOOK ? parsed.theme : DEFAULT_SETTINGS.theme;
      const { look: _look, ...rest } = parsed;
      void _look;
      return {
        ...DEFAULT_SETTINGS,
        ...rest,
        theme: theme ?? DEFAULT_SETTINGS.theme,
        background: isBackground(parsed.background) ? parsed.background : DEFAULT_SETTINGS.background,
        connectLook: isConnectLook(parsed.connectLook) ? parsed.connectLook : DEFAULT_SETTINGS.connectLook,
        hubStyle: isHubStyle(parsed.hubStyle) ? parsed.hubStyle : DEFAULT_SETTINGS.hubStyle,
        fraudService: isFraudService(parsed.fraudService) ? parsed.fraudService : DEFAULT_SETTINGS.fraudService,
        fraudKeys: keysOf(parsed.fraudKeys),
        fraudOnConnect: typeof parsed.fraudOnConnect === "boolean" ? parsed.fraudOnConnect : DEFAULT_SETTINGS.fraudOnConnect,
        protocols: { ...DEFAULT_SETTINGS.protocols, ...(parsed.protocols ?? {}) },
      };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return DEFAULT_SETTINGS;
}

/** Stored keys, strings only: anything else in storage is dropped. */
function keysOf(v: unknown): FraudKeys {
  if (!v || typeof v !== "object") return {};
  const out: FraudKeys = {};
  for (const id of ["ipqs", "scamalytics", "proxycheck", "abuseipdb"] as const) {
    const k = (v as Record<string, unknown>)[id];
    if (typeof k === "string") out[id] = k;
  }
  return out;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, look: LOOK }));
  } catch {
    /* ignore */
  }
}

/** The enabled transports as the wire list the engine expects, or undefined
    when all four are on (engine treats that as "probe everything"). */
export function protocolList(p: Protocols): string[] | undefined {
  const on = Object.entries(p)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return on.length === 4 ? undefined : on;
}
