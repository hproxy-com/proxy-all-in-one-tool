import { useLayoutEffect, useRef, type ReactNode } from "react";
import { formatAgo, formatBytes, formatDuration, placeOf } from "../../lib/connect";
import type { FraudRow } from "../../lib/fraud";
import type { ConnectLook, HubStyle } from "../../lib/look";
import { isMobile, thisDevice, type ConnectStatus } from "../../lib/tauri";
import { FraudChip } from "../FraudScore";
import HLetter from "../HLetter";
import { Button, Check, Flag, Icon, Input, Switch, Tile, cx } from "../ui";
import DotMap from "./DotMap";

/* The left half of Connect: the connection itself, like a VPN's main card.

   The same card as the extension's popup (look A): the state
   in words, the H switch, the route from this computer through the H to the
   exit. How a connection that is up looks is a setting (lib/look.ts,
   CONNECT_LOOKS): a map with your country lit, the card's dots lit from the
   H, a blue card, rings, or the route alone. Under it, where the switch goes
   ("Going through"), and while connected the numbers and the three things you
   do with a connection.

   The H in the middle is a setting too (lib/look.ts, HUB_STYLES): a big button,
   the route as a switch, or the small sign. Button and switch connect like the
   switch at the top, which stays as it is. */

export type Phase = "off" | "connecting" | "on" | "rotating" | "leaving";

/** What the switch connects to, as the card shows it. */
export type TargetView = {
  kind: "fixed" | "list" | "free";
  name: string;
  sub?: string;
  /** Lowercase code, for a flag where one is known. */
  cc?: string;
};

export type ConnectionCardProps = {
  phase: Phase;
  /** How a connection that is up looks (Settings, Look). */
  look: ConnectLook;
  /** The H in the middle of the route: a button, a switch, or the small sign. */
  hub: HubStyle;
  /** The fraud score of the address you appear as, when looked up. */
  fraud?: FraudRow | null;
  failing: boolean;
  status: ConnectStatus | null;
  view: TargetView | null;
  now: number;
  busy: boolean;
  onToggle: () => void;
  canConnect: boolean;
  onChangeTarget: () => void;
  onRotate: () => void;
  onProbe: () => void;
  onCopy: () => void;
  copied: boolean;
  error: string | null;

  useSystem: boolean;
  setUseSystem: (v: boolean) => void;
  canAutomate: boolean;
  manualWhy?: string;
  /** Where the address goes by hand when the system proxy cannot be switched
      from here (a phone's Wi-Fi settings, a Linux desktop without GNOME). */
  manualSteps?: string;
  advanced: boolean;
  setAdvanced: (v: boolean) => void;
  listen: string;
  setListen: (v: string) => void;
};

function TargetIcon({ view }: { view: TargetView }) {
  if (view.cc) return <Flag cc={view.cc} />;
  if (view.kind === "list") return <Icon.layers />;
  return <Icon.globe />;
}

export default function ConnectionCard(p: ConnectionCardProps) {
  const { phase, failing, status, view } = p;
  const on = phase === "on";
  // A phone has no system proxy an app may switch: the relay's address goes
  // into the Wi-Fi settings by hand, and the card says so.
  const phone = isMobile();
  const health = status?.health ?? null;
  const stats = status?.stats ?? null;
  const source = status?.source ?? null;
  const place = health?.ok ? placeOf(health) : undefined;
  const exitCc = health?.ok ? health.country_code?.toLowerCase() : undefined;

  const label =
    phase === "off"
      ? "Not connected"
      : phase === "connecting"
        ? "Connecting"
        : phase === "rotating"
          ? "Changing the exit"
          : phase === "leaving"
            ? "Disconnecting"
            : failing
              ? "Connected, not answering"
              : "Connected";

  const headline =
    phase === "off" || phase === "leaving"
      ? "Your own address"
      : phase === "connecting"
        ? (view?.name ?? "Connecting")
        : (place ?? view?.name ?? "Connected");

  const sub: ReactNode =
    phase === "off"
      ? "Sites see where you really are"
      : phase === "leaving"
        ? "Putting everything back as it was"
        : phase === "connecting"
          ? view?.kind === "free"
            ? "Finding a free exit that works…"
            : "Starting the relay and checking it…"
          : phase === "rotating"
            ? "Getting a new IP…"
            : failing
              ? (health?.error ?? "the last checks got no answer")
              : health?.exit_ip
                ? `${health.exit_ip}${health.asn_org ? ` · ${health.asn_org}` : ""}`
                : !health
                  ? "Finding out which address sites see…"
                  : health.reflects_exit
                    ? "The exit did not say its address"
                    : `${health.target} cannot name the address; the HProxy judge can (Settings)`;

  const foot =
    phase === "off"
      ? `Nothing on ${thisDevice()} changes until you connect`
      : phase === "connecting"
        ? "Setting it up and checking it carries traffic…"
        : phase === "leaving"
          ? status?.system_proxy
            ? "Putting the system setting back…"
            : "Stopping the relay…"
          : phase === "rotating"
            ? "New connections move to the next exit"
            : status?.system_proxy
              ? "System proxy on: browsers and most programs go through it"
              : `Running on ${status?.listen ?? "127.0.0.1"}: ${phone ? "set it as the Wi-Fi proxy" : "point your program at it"}`;

  // The exit end of the route: where traffic comes out once connected,
  // otherwise where the switch will take it.
  const exitName = on && place ? (health?.city ?? place) : (view?.name ?? "Pick a place");
  const exitFlag = on && exitCc ? exitCc : view?.cc;
  const uptime = status?.started_at_ms ? formatDuration(p.now - status.started_at_ms) : "0:00";
  // The Map look's country: where you appear once connected, before that the
  // place the switch goes to when it is a country.
  const mapCc = on || phase === "rotating" ? (exitCc ?? view?.cc) : view?.cc;

  // The blue card spreads from the H, wherever the H is: its middle, measured
  // into --hub-x/--hub-y (for the switch, the end the H slides to).
  const statusRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const card = statusRef.current;
    if (!card) return;
    const measure = () => {
      const mark = card.querySelector<HTMLElement>("[data-hub-origin]");
      if (!mark) return;
      const c = card.getBoundingClientRect();
      const m = mark.getBoundingClientRect();
      card.style.setProperty("--hub-x", `${Math.round(m.left + m.width / 2 - c.left)}px`);
      card.style.setProperty("--hub-y", `${Math.round(m.top + m.height / 2 - c.top)}px`);
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(card);
    return () => seen.disconnect();
  }, [p.hub, p.look, phase]);

  const toggleTitle = phase === "off" ? (p.canConnect ? "Connect" : "Pick a place to connect to first") : "Disconnect";
  const lit = phase !== "off" && phase !== "leaving";

  return (
    <div className="flex flex-col gap-3">
      <section className="ux-conn" data-phase={phase} data-look={p.look} data-hub={p.hub} data-failing={failing || undefined}>
        <div ref={statusRef} className="ux-status">
          <div className="top">
            <div className="min-w-0 flex-1">
              <span className="ux-live">
                <i /> {label}
              </span>
              <div key={`h-${phase}-${headline}`} className="ux-city">
                {headline}
              </div>
              <div key={`s-${phase}-${typeof sub === "string" ? sub : ""}`} className="ux-ip num">
                {sub}
              </div>
              {on && !failing && p.fraud && <FraudChip row={p.fraud} />}
            </div>
            <Switch
              on={lit}
              busy={phase === "connecting" || phase === "rotating" || phase === "leaving"}
              disabled={p.busy || (phase === "off" && !p.canConnect)}
              onChange={p.onToggle}
              label="Connection"
              title={toggleTitle}
            />
          </div>

          {p.look === "map" && <DotMap cc={mapCc} />}

          <div className="ux-route">
            <span className="end">
              {phone ? <Icon.phone /> : <Icon.laptop />}
              <span className="name">{thisDevice(true)}</span>
            </span>
            {p.hub === "switch" ? (
              <HSwitch on={lit} disabled={p.busy} onToggle={p.onToggle} title={toggleTitle} />
            ) : (
              <>
                <span className="ux-wire left">
                  <i />
                  <b />
                </span>
                {p.hub === "button" ? (
                  <span className="ux-hbutton" data-hub-origin>
                    <button type="button" className="ux-hface" aria-pressed={lit} aria-label="Connection" title={toggleTitle} disabled={p.busy} onClick={p.onToggle}>
                      <HFaceParts />
                    </button>
                  </span>
                ) : (
                  <span className="ux-hub" data-hub-origin>
                    <HLetter />
                  </span>
                )}
                <span className="ux-wire right">
                  <i />
                  <b />
                </span>
              </>
            )}
            <span className="end exit" title={exitName}>
              {exitFlag ? (
                <span key={`${on}-${health?.exit_ip ?? ""}-${exitFlag}`} className={cx("ux-exit-flag", on && "arrived")}>
                  <Flag cc={exitFlag} />
                </span>
              ) : view?.kind === "list" ? (
                <Icon.layers />
              ) : (
                <Icon.globe />
              )}
              <span className="name">{exitName}</span>
            </span>
          </div>

          <div className="foot">
            <Icon.shield />
            <span key={`f-${phase}-${foot}`} className="text">
              {foot}
            </span>
            <span className="ms num">{on && health?.ok && health.latency_ms != null ? `${health.latency_ms} ms` : "—"}</span>
          </div>
        </div>
      </section>

      {/* Where the switch goes, and the way to change it. */}
      <div className="ux-target">
        {view && (
          <span className="icon">
            <TargetIcon view={view} />
          </span>
        )}
        <div className="what">
          <div className="label">{on || phase === "rotating" ? "Connected through" : "Going through"}</div>
          <div className="name">{view?.name ?? "Nothing picked yet"}</div>
          <div className="sub num">
            {view?.sub ??
              (on && source
                ? source.kind === "pool"
                  ? (source.detail ?? "a free exit")
                  : source.in_use
                : "Pick one of your proxies, a list, or a free country")}
          </div>
        </div>
        <button type="button" className="ux-link" onClick={p.onChangeTarget}>
          Change <Icon.arrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {(on || phase === "rotating") && status && (
        <>
          <div className="ux-tiles">
            <Tile
              label="Round trip"
              value={health ? (health.ok ? `${health.latency_ms ?? "?"} ms` : "No answer") : "…"}
              tone={failing ? "danger" : undefined}
              sub={
                health
                  ? health.ok
                    ? `to ${health.target}, ${formatAgo(p.now - health.checked_at_ms)}`
                    : health.failures_in_a_row > 1
                      ? `${health.failures_in_a_row} checks in a row`
                      : "the last check failed"
                  : "first check running"
              }
            />
            <Tile label="Connected for" value={uptime} sub={`on ${status.listen ?? ""}`} />
            <Tile
              label="Traffic"
              value={formatBytes(stats?.bytes_down ?? 0)}
              sub={`${formatBytes(stats?.bytes_up ?? 0)} up · ${stats?.connections ?? 0} connections${stats?.rotations ? ` · ${stats.rotations} switches` : ""}`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {source?.can_rotate && (
              <Button disabled={p.busy} onClick={p.onRotate} title="Move to the next proxy in the list, or a fresh free exit">
                <Icon.refresh className="h-4 w-4" />
                New IP
              </Button>
            )}
            <Button disabled={p.busy} onClick={p.onProbe} title="One check through the relay, right now">
              <Icon.shield className="h-4 w-4" />
              Test now
            </Button>
            <Button onClick={p.onCopy} title="The relay's address, for a program's proxy settings">
              <Icon.copy className="h-4 w-4" />
              {p.copied ? "Copied" : "Copy address"}
            </Button>
          </div>
        </>
      )}

      {p.error && <p className="px-1 text-[13.5px] font-semibold text-danger">{p.error}</p>}
      {status?.notice && <p className="px-1 text-[13.5px] font-medium text-ink-mute">{status.notice}</p>}

      {/* A program with its own proxy settings needs the address typed in; on
          a phone, the Wi-Fi settings do. */}
      {on && status && !status.system_proxy && <ProgramSettings listen={status.listen ?? ""} phone={phone} steps={p.manualSteps} />}

      <div className="ux-panel flex flex-col gap-3 p-4">
        {/* A phone has no system proxy an app may switch, so the box could
            never be ticked there. */}
        {!phone && (
          <Check
            on={p.canAutomate ? p.useSystem : false}
            onChange={(v) => p.canAutomate && p.setUseSystem(v)}
            label="Set it as the system proxy"
            disabled={!p.canAutomate || on}
          />
        )}
        <p className="text-[13px] font-medium leading-relaxed text-ink-mute">
          {phone
            ? "A phone does not let an app switch its proxy. Once connected, the address goes into the Wi-Fi settings, and apps that follow them go through HProxy while it is open."
            : !p.canAutomate && p.manualWhy
              ? `Not automatic here: ${p.manualWhy}. You get the address to type in instead.`
              : on
                ? "Changes the next time you connect. Put back exactly as found when you disconnect."
                : "Browsers and most programs follow the system proxy. It is put back exactly as found when you disconnect."}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {p.advanced ? (
            <>
              <span className="text-[13px] font-semibold text-ink-mute">Listen on</span>
              <Input value={p.listen} onChange={p.setListen} placeholder="127.0.0.1:8080" width="short" mono label="Listen address" />
              <span className="text-[12.5px] font-medium text-ink-mute">Empty is 127.0.0.1:8080, or the next free port.</span>
            </>
          ) : (
            <button type="button" className="ux-link" onClick={() => p.setAdvanced(true)} title="Pick the port the relay listens on">
              Choose the port <Icon.arrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** What the H button and the H switch's knob are made of, back to front: the
    blue that fills it from the middle, its edge (dashed when off, a light
    running round it while connecting), the ring that leaves it once connected,
    the slow ping after, and the H. */
function HFaceParts() {
  return (
    <>
      <span className="fill" />
      <span className="edge" />
      <span className="wave" />
      <span className="ping" />
      <HLetter />
    </>
  );
}

/* The route as a switch: pressing anywhere on it slides the H from this
   computer to the exit, and the line fills blue behind it. Where the H stands
   is one number, --hpos in globals.css (0 at this computer, 1 at the exit),
   so the knob and the blue line can never drift apart. */
function HSwitch({ on, disabled, onToggle, title }: { on: boolean; disabled: boolean; onToggle: () => void; title: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label="Connection" title={title} disabled={disabled} onClick={onToggle} className="ux-hswitch">
      <span className="rail">
        <i className="lit">
          <b />
        </i>
      </span>
      <span className="origin" data-hub-origin />
      <span className="ux-hknob">
        <span className="ux-hface">
          <HFaceParts />
        </span>
      </span>
    </button>
  );
}

function splitAddr(addr: string): [string, string] {
  const i = addr.lastIndexOf(":");
  if (i < 0) return [addr, ""];
  return [addr.slice(0, i).replace(/^\[|\]$/g, ""), addr.slice(i + 1)];
}

/* The address to type in by hand. On a phone the rows carry the names the
   Wi-Fi settings use (Android: Proxy, Proxy hostname, Proxy port), which take
   an HTTP proxy with no login. The steps are the engine's own words for this
   system (hproxy-system, Support::Manual). */
function ProgramSettings({ listen, phone, steps }: { listen: string; phone: boolean; steps?: string }) {
  const [host, port] = splitAddr(listen);
  return (
    <div className="ux-panel p-4">
      <p className="text-[12.5px] font-bold text-accent-ink">
        {phone ? "In the Wi-Fi settings, under Proxy" : "In your program's proxy settings"}
      </p>
      <dl className="num mt-2 grid grid-cols-[auto_1fr] gap-x-8 gap-y-1 text-[14px] font-semibold">
        {phone ? (
          <>
            <dt className="text-ink-mute">Proxy</dt>
            <dd className="text-ink">Manual</dd>
            <dt className="text-ink-mute">Hostname</dt>
            <dd className="text-ink">{host}</dd>
            <dt className="text-ink-mute">Port</dt>
            <dd className="text-ink">{port}</dd>
          </>
        ) : (
          <>
            <dt className="text-ink-mute">Type</dt>
            <dd className="text-ink">HTTP or SOCKS5</dd>
            <dt className="text-ink-mute">Address</dt>
            <dd className="text-ink">{host}</dd>
            <dt className="text-ink-mute">Port</dt>
            <dd className="text-ink">{port}</dd>
            <dt className="text-ink-mute">Username, password</dt>
            <dd className="text-ink">leave empty</dd>
          </>
        )}
      </dl>
      {steps && <p className="mt-3 text-[13px] font-medium leading-relaxed text-ink-mute">{steps}</p>}
    </div>
  );
}
