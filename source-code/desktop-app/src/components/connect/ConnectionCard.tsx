import { useLayoutEffect, useRef, type ReactNode } from "react";
import { formatAgo, formatBytes, formatDuration, formatRate, placeOf } from "../../lib/connect";
import type { FraudSet } from "../../lib/fraud";
import type { LeakAction, LeakRow } from "../../lib/leaks";
import type { ConnectLook, HubStyle } from "../../lib/look";
import { isMobile, thisDevice, type ConnectStatus } from "../../lib/tauri";
import { FraudChip } from "../FraudScore";
import HLetter from "../HLetter";
import { Button, Check, Flag, Icon, InfoTip, Input, Switch, Tile, cx, useTip } from "../ui";
import DotMap from "./DotMap";

/* The left half of Connect: the connection itself, like a VPN's main card.

   The same card as the extension's popup (look A): the state
   in words, the H switch, the route from this computer through the H to the
   exit. How a connection that is up looks is a setting (lib/look.ts,
   CONNECT_LOOKS): a map with your country lit, the card's dots lit from the
   H, a blue card, rings, or the route alone. Under it, where the switch goes
   ("Going through"), and while connected the numbers and the three things you
   do with a connection.

   The H in the middle is a setting too (lib/look.ts, HUB_STYLES): a big button
   with its word under it, the route as a switch, or the small sign. A card has
   one control: the switch at the top shows only with the small sign. */

/** "rotating" is Next IP and "switching" is another place picked while
    connected: in both the connection stays up and only what is behind it
    changes, so both read as connected (`changing`). */
export type Phase = "off" | "connecting" | "on" | "rotating" | "switching" | "leaving";

/** Connected, with the place or the exit being changed. */
export const changing = (phase: Phase): boolean => phase === "rotating" || phase === "switching";

/** Something is under way that the H shows as busy. */
export const busyPhase = (phase: Phase): boolean => phase === "connecting" || phase === "leaving" || changing(phase);

/** What the switch connects to, as the card shows it. */
export type TargetView = {
  kind: "proxy" | "group" | "free";
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
  /** The fraud scores of the address you appear as, when looked up. */
  fraud?: FraudSet | null;
  /** The leak check's lines while connected (lib/leaks.ts). */
  leaks?: LeakRow[] | null;
  /** A button on a leak check line was pressed. */
  onLeakAction: (a: LeakAction) => void;
  failing: boolean;
  status: ConnectStatus | null;
  /** Bytes a second through the relay, up and down, while connected. */
  rate?: { up: number; down: number } | null;
  view: TargetView | null;
  now: number;
  busy: boolean;
  onToggle: () => void;
  canConnect: boolean;
  onChangeTarget: () => void;
  onRotate: () => void;
  /** Back to the group's proxy before: only while connected through a group. */
  onBack?: () => void;
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

export function TargetIcon({ view }: { view: TargetView }) {
  if (view.cc) return <Flag cc={view.cc} />;
  if (view.kind === "group") return <Icon.layers />;
  return <Icon.globe />;
}

/** What the connection says, the same words in every Connect design
    (Settings, "Connect page"; ./ConnectDesigns.tsx): the state, the place,
    the route's two ends and the live numbers. */
export function connectionWords(p: ConnectionCardProps) {
  const { phase, failing, status, view } = p;
  const on = phase === "on";
  // A phone has no system proxy an app may switch: a VPN carries every app
  // to the relay instead (src-tauri/src/vpn.rs).
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
        : phase === "switching"
          ? "Switching"
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
      : phase === "connecting" || phase === "switching"
        ? (view?.name ?? "Connecting")
        : (place ?? view?.name ?? "Connected");

  const sub: ReactNode =
    phase === "off"
      ? ""
      : phase === "leaving"
        ? "Putting things back…"
        : phase === "connecting" || phase === "switching"
          ? view?.kind === "free"
            ? "Finding a free exit that works…"
            : "Checking it works…"
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
                    : "Address unknown with this check (Settings)";

  // The foot line is for a connection that is up: how programs reach it, and
  // the live speed beside the round trip. Nothing while it is off.
  const foot =
    on || changing(phase)
      ? status?.system_proxy
        ? phone
          ? "Every app (VPN)"
          : "System proxy"
        : `${status?.listen ?? "127.0.0.1"}${phone ? " in the Wi-Fi settings" : ""}`
      : "";
  const speed = on && p.rate ? `↓ ${formatRate(p.rate.down)}  ↑ ${formatRate(p.rate.up)}` : "";

  // The exit end of the route: where traffic comes out once connected,
  // otherwise where the switch will take it.
  const exitName = on && place ? (health?.city ?? place) : (view?.name ?? "Pick a place");
  const exitFlag = on && exitCc ? exitCc : view?.cc;
  const uptime = status?.started_at_ms ? formatDuration(p.now - status.started_at_ms) : "0:00";
  // The Map look's country: where you appear once connected, before that (and
  // while switching) the place the switch goes to when it is a country.
  const mapCc = on || phase === "rotating" ? (exitCc ?? view?.cc) : view?.cc;

  const toggleTitle = phase === "off" ? (p.canConnect ? "Connect" : "Pick a place to connect to first") : "Disconnect";
  const lit = phase !== "off" && phase !== "leaving";
  // The word under the H button: what pressing it does now.
  // Grey while nothing is picked yet (the route names "Pick a place").
  const caption =
    phase === "off"
      ? "Connect"
      : phase === "connecting"
        ? "Connecting"
        : phase === "switching"
          ? "Switching"
          : phase === "rotating"
            ? "New IP"
            : phase === "leaving"
              ? "Disconnecting"
              : "Disconnect";

  return { on, phone, health, stats, source, place, exitCc, label, headline, sub, foot, speed, exitName, exitFlag, uptime, mapCc, toggleTitle, caption, lit };
}

export type ConnectionWords = ReturnType<typeof connectionWords>;

/** A piece of the connection: the card's props and its words. */
export type ConnPart = { p: ConnectionCardProps; w: ConnectionWords };

/** The top of the card: the state in words, the switch, the route from this
    computer through the H to the exit, and the foot line. */
export function ConnStatus({ p, w }: ConnPart) {
  const { phase, failing, view } = p;
  const { on, phone, health, label, headline, sub, foot, speed, exitName, exitFlag, mapCc, toggleTitle, caption, lit } = w;

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

  return (
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
            {sub !== "" && (
              <div key={`s-${phase}-${typeof sub === "string" ? sub : ""}`} className="ux-ip num">
                {sub}
              </div>
            )}
            {on && !failing && p.fraud && <FraudChip set={p.fraud} />}
          </div>
          {p.hub === "small" && (
            <Switch
              on={lit}
              busy={busyPhase(phase)}
              disabled={p.busy || (phase === "off" && !p.canConnect)}
              onChange={p.onToggle}
              label="Connection"
              title={toggleTitle}
            />
          )}
        </div>

        {p.look === "map" && <DotMap cc={mapCc} phase={failing ? "off" : phase} zoom={on && !failing} lat={health?.latitude} lon={health?.longitude} />}

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
                  <button type="button" className="ux-hface" aria-pressed={lit} aria-label={caption} title={toggleTitle} disabled={p.busy} onClick={p.onToggle}>
                    <HFaceParts />
                  </button>
                  <button type="button" className="ux-hcaption" data-ready={p.canConnect || undefined} tabIndex={-1} aria-hidden="true" disabled={p.busy} onClick={p.onToggle}>
                    {caption}
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
          <button
            type="button"
            className="end exit"
            title={phase === "off" ? "Pick the place to connect through" : exitName}
            disabled={phase !== "off" || p.busy}
            onClick={p.onChangeTarget}
          >
            {exitFlag ? (
              <span key={`${on}-${health?.exit_ip ?? ""}-${exitFlag}`} className={cx("ux-exit-flag", on && "arrived")}>
                <Flag cc={exitFlag} />
              </span>
            ) : view?.kind === "group" ? (
              <Icon.layers />
            ) : (
              <Icon.globe />
            )}
            <span className="name">{exitName}</span>
          </button>
        </div>

        {foot !== "" && (
          <div className="foot">
            <Icon.shield />
            <span key={`f-${phase}-${foot}`} className="text num">
              {foot}
            </span>
            {speed && <span className="speed num">{speed}</span>}
            <span className="ms num">{on && health?.ok && health.latency_ms != null ? `${health.latency_ms} ms` : "—"}</span>
          {/* Test now: one check through the relay, beside the number it renews. */}
          {on && (
            <button type="button" className="ux-iconlink" disabled={p.busy} onClick={p.onProbe} title="Test the connection now" aria-label="Test the connection now">
              <Icon.refresh />
            </button>
          )}
          </div>
        )}
      </div>
    </section>
  );
}

/** What you are connected through, New IP and Change. With `routeShown`, the
    route above already names the place while off (press it to change), so the
    row waits until the connection is up. */
export function TargetRow({ p, w, routeShown = true }: ConnPart & { routeShown?: boolean }) {
  const { phase, view } = p;
  const { on, source } = w;
  if (routeShown && !on && !changing(phase)) return null;
  return (
    <div className="ux-target">
      {view && (
        <span className="icon">
          <TargetIcon view={view} />
        </span>
      )}
      <div className="what">
        <div className="label">{on || phase === "rotating" ? "Connected through" : "Going through"}</div>
        <div className="name">{view?.name ?? "Nothing picked yet"}</div>
        {(view?.sub || (on && source)) && (
          <div className="sub num">
            {view?.sub ?? (source?.kind === "pool" ? (source.detail ?? "a free exit") : source?.in_use)}
          </div>
        )}
      </div>
      <div className="acts flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
        {/* New IP belongs with the place: the next proxy of the group, or a
            fresh free exit; a group can go back to the one before too. */}
        {on && p.onBack && (
          <button type="button" className="ux-link" disabled={p.busy} onClick={p.onBack} title="Back to the proxy before this one in the group">
            <Icon.arrowLeft className="h-3.5 w-3.5" /> Back
          </button>
        )}
        {on && source?.can_rotate && (
          <button type="button" className="ux-link" disabled={p.busy} onClick={p.onRotate} title="Move to the next proxy in the group, or a fresh free exit">
            <Icon.refresh className="h-3.5 w-3.5" /> New IP
          </button>
        )}
        <button type="button" className="ux-link" onClick={p.onChangeTarget}>
          Change <Icon.arrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** The live numbers: the round trip, the time connected, the traffic. Not
    shown since 2026-09-29: the round trip stays at the end of the status's
    foot line. Kept for a stats view. */
export function LiveTiles({ p, w }: ConnPart) {
  const { failing, status } = p;
  const { health, stats, uptime } = w;
  if (!status) return null;
  return (
    <div className="ux-connrow ux-tiles">
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
  );
}

/** New IP, Test now, Copy address as a row of buttons. Not shown since
    2026-09-30, because a row of them in the middle of the connection read as
    unrelated: New IP sits by Change, Test now by the round trip, Copy by the
    system proxy. */
export function ConnActions({ p, w }: ConnPart) {
  const { source } = w;
  return (
    <div className="ux-connrow flex flex-wrap items-center gap-2">
      {source?.can_rotate && (
        <Button disabled={p.busy} onClick={p.onRotate} title="Move to the next proxy in the group, or a fresh free exit">
          <Icon.refresh className="h-4 w-4" />
          New IP
        </Button>
      )}
      <Button disabled={p.busy} onClick={p.onProbe} title="Check the connection now">
        <Icon.shield className="h-4 w-4" />
        Test now
      </Button>
      <Button onClick={p.onCopy} title="The local address, for a program's proxy settings">
        <Icon.copy className="h-4 w-4" />
        {p.copied ? "Copied" : "Copy address"}
      </Button>
    </div>
  );
}

/** What the last action said: an error, or a notice from the relay. */
export function ConnMessages({ p }: { p: ConnectionCardProps }) {
  const { status } = p;
  return (
    <>
      {p.error && <p className="ux-connrow text-[13.5px] font-semibold text-danger">{p.error}</p>}
      {status?.notice && <p className="ux-connrow text-[13.5px] font-medium text-ink-mute">{status.notice}</p>}
    </>
  );
}

/** Set it as the system proxy, the port, and what either does. */
export function SystemProxyRow({ p, w }: ConnPart) {
  const { on, phone } = w;
  return (
    <div className="ux-connrow flex flex-col gap-2">
      {/* A phone always connects every app, through the VPN: no box to tick,
          and no port to choose either (its apps reach the relay through the
          VPN, and a taken port is swapped for a free one, connect.rs). */}
      {!phone && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <span className="flex items-center gap-1.5">
            <Check
              on={p.canAutomate ? p.useSystem : false}
              onChange={(v) => p.canAutomate && p.setUseSystem(v)}
              label="Use for the whole computer"
              disabled={!p.canAutomate || on}
              title={on ? "Changes the next time you connect" : undefined}
            />
            <InfoTip label="using it for the whole computer">
              <p>Browsers and most programs go through the proxy while you are connected. Your settings are put back as they were when you disconnect.</p>
              <p>Off: only the programs you point at the local address use it.</p>
            </InfoTip>
          </span>
          {!p.advanced && (
            <button type="button" className="ux-link" onClick={() => p.setAdvanced(true)} title="Pick the local port">
              Choose the port <Icon.arrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      {/* Only what you act on: where the address goes when it cannot be set from here. */}
      {(phone || (!p.canAutomate && p.manualWhy)) && (
        <p className="text-[13px] font-medium leading-relaxed text-ink-mute">
          {phone
            ? "Every app on this phone goes through the proxy. The first time, Android asks you to allow HProxy's VPN."
            : `Not automatic here: ${p.manualWhy}.`}
        </p>
      )}
      {/* The relay's own address, for a program with proxy settings of its own.
          On a phone every app already goes through the VPN. */}
      {on && p.status?.listen && !phone && (
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] font-medium text-ink-mute">
          Local address <b className="num font-bold text-ink">{p.status.listen}</b>
          <button type="button" className="ux-link" onClick={p.onCopy} title="The local address, for a program's proxy settings">
            <Icon.copy className="h-3.5 w-3.5" /> {p.copied ? "Copied" : "Copy"}
          </button>
        </p>
      )}
      {p.advanced && !phone && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] font-semibold text-ink-mute">Listen on</span>
          <Input value={p.listen} onChange={p.setListen} placeholder="127.0.0.1:8080" width="short" mono label="Listen address" />
          <span className="text-[12.5px] font-medium text-ink-mute">Empty: 127.0.0.1:8080</span>
        </div>
      )}
    </div>
  );
}

export default function ConnectionCard(p: ConnectionCardProps) {
  const w = connectionWords(p);
  const { phase, status } = p;
  const { on, phone } = w;
  return (
    // One piece: the status on top and its rows under it, split by hairlines,
    // never a stack of separate boxes (they read as a generated page).
    <div className="ux-connpanel">
      <ConnStatus p={p} w={w} />
      <TargetRow p={p} w={w} />
      {(on || changing(phase)) && status && (
        <>
          {on && p.leaks && <LeakCheck rows={p.leaks} onAction={p.onLeakAction} />}
        </>
      )}

      <ConnMessages p={p} />

      {/* A program with its own proxy settings needs the address typed in; on
          a phone, the Wi-Fi settings do. */}
      {on && status && !status.system_proxy && <ProgramSettings listen={status.listen ?? ""} phone={phone} steps={p.manualSteps} />}

      <SystemProxyRow p={p} w={w} />
    </div>
  );
}

/* The privacy check, as compact as it can be: one line, a mark per way a
   site could still learn about you through the proxy
   (lib/leaks.ts), coloured by the verdict, never a filled pill. Each mark's
   bubble says what was found and what it means. Only a warning adds a line,
   with its fix where there is one: the extension for WebRTC, the time zone
   matched to the exit. All clear, the check is that one line. */
export function LeakCheck({ rows, onAction }: { rows: LeakRow[]; onAction: (a: LeakAction) => void }) {
  const warnings = rows.filter((r) => r.tone === "warn");
  return (
    <div className="ux-connrow ux-privacy">
      <div className="marks">
        <span className="title">
          Privacy
          <InfoTip label="the privacy check">What a site can still learn about you through the proxy, checked while you are connected.</InfoTip>
        </span>
        {rows.map((r) => (
          <LeakMark key={r.id} row={r} />
        ))}
      </div>
      {warnings.map((r) => (
        <p key={r.id} className="warning">
          <Icon.warning />
          <span className="headline">{r.headline}</span>
          {r.actions?.map((a) => (
            <button key={a.id} type="button" className="ux-link" onClick={() => onAction(a.id)}>
              {a.label} <Icon.arrowRight className="h-3.5 w-3.5" />
            </button>
          ))}
        </p>
      ))}
    </div>
  );
}

/** One way of the privacy check: its mark and name; what was found in its bubble. */
function LeakMark({ row }: { row: LeakRow }) {
  const tip = useTip(
    <>
      <p>
        <b>{row.label}:</b> {row.headline}
      </p>
      {row.detail && <p>{row.detail}</p>}
    </>,
  );
  return (
    <>
      <button type="button" className="mark" data-tone={row.tone} aria-label={`${row.label}: ${row.headline}`} {...tip.trigger}>
        {row.tone === "ok" ? <Icon.check /> : row.tone === "warn" ? <Icon.warning /> : <Icon.clock />}
        {row.label}
      </button>
      {tip.bubble}
    </>
  );
}

/** What the H button and the H switch's knob are made of, back to front: the
    blue that fills it from the middle, its edge (dashed when off, a light
    running round it while connecting), the ring that leaves it once connected,
    the slow ping after, and the H. */
export function HFaceParts() {
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
export function HSwitch({ on, disabled, onToggle, title }: { on: boolean; disabled: boolean; onToggle: () => void; title: string }) {
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
export function ProgramSettings({ listen, phone, steps }: { listen: string; phone: boolean; steps?: string }) {
  const [host, port] = splitAddr(listen);
  return (
    <div className="ux-connrow">
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
