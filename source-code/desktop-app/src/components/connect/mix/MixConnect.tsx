import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBack } from "../../../lib/back";
import { countryName } from "../../../lib/checker";
import { formatRate } from "../../../lib/connect";
import { copyText } from "../../../lib/tauri";
import { FraudChip } from "../../FraudScore";
import HLetter from "../../HLetter";
import { DigitRoll, Flag, Icon, cx } from "../../ui";
import { ConnMessages, LeakCheck, SystemProxyRow, connectionWords, type ConnectionCardProps } from "../ConnectionCard";
import { useConnection } from "../connection";
import { ChangeRows, useChangeList } from "../QuickChange";
import MixMap, { type Fade, type PinPlace } from "./MixMap";
import { CITY_S, Flight, TONES, WORLD_S, camOn, centreOf, countryOf, countryScale } from "./worldMap";

/* Mix: the phone app's main screen on the computer (the A + C mix of the design rounds): C's
   dot map over the whole page, A's switch in the middle.
   Off, the map waits on the place you will appear in under a pin. Connecting, its country
   lights up. On, the page turns blue from where the knob lands and shows the same map in blue,
   and the camera dives to the city. The place sits at the bottom; beside it, once you are on,
   the menu with what only a computer has (the whole computer or one program, the local
   address, what sites see, the fraud score). The same pieces and words as every other Connect
   design (ConnectionCard.tsx); only the look is the phone's. */

type Props = { card: ConnectionCardProps; side: ReactNode; note?: ReactNode };

type Sheet = "places" | "change" | "menu";

/** A place on the map, unless missing or the nowhere at 0,0 (what IP data says when it knows
    only a country, or nothing). */
const known = (lat?: number | null, lon?: number | null): lat is number =>
  lat != null && lon != null && !(Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01);

function useDark(): boolean {
  const read = () => typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "midnight";
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const o = new MutationObserver(() => setDark(read()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => o.disconnect();
  }, []);
  return dark;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const o = new ResizeObserver(fit);
    o.observe(el);
    return () => o.disconnect();
  }, []);
  return [ref, size] as const;
}

export default function MixConnect({ card: p, side, note }: Props) {
  const w = connectionWords(p);
  const dark = useDark();
  const [rootRef, { w: W, h: H }] = useSize<HTMLDivElement>();
  // places: Quick connect with Connect's paste field (a proxy pasted here); change: Quick change
  // (the card's Change); menu: what only a computer has.
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // Closing: the sheet goes back down through the window's edge first (styles/connect-mix.css).
  const [leaving, setLeaving] = useState(false);
  const shownSheet = useRef(sheet);
  shownSheet.current = sheet;
  const closeSheet = () => {
    if (!shownSheet.current) return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) setSheet(null);
    else setLeaving(true);
  };
  const openSheet = (s: Sheet) => {
    setLeaving(false);
    setSheet(s);
  };
  // Escape on a computer, Back on a phone, put the sheet away.
  useBack(!!sheet && !leaving, closeSheet);
  useEffect(() => {
    if (!sheet || leaving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, leaving]); // eslint-disable-line react-hooks/exhaustive-deps
  const { quickAsk } = useConnection();
  const changes = useChangeList();

  const phase = p.phase;
  const on = phase === "on" || phase === "switching" || phase === "rotating";
  const busy = phase === "connecting";

  // Connect's paste field asked for (a proxy pasted on this page): the places come up with it.
  // An ask from an earlier visit is not one.
  useEffect(() => {
    if (quickAsk && Date.now() - quickAsk < 1500) openSheet("places");
  }, [quickAsk]); // eslint-disable-line react-hooks/exhaustive-deps
  // A place taken in a sheet (a row, the field's Connect) starts a connect: the sheet gives
  // way so the map can show it. Anything else in it (Check again) leaves it open.
  useEffect(() => {
    if ((phase === "connecting" || phase === "switching") && (shownSheet.current === "places" || shownSheet.current === "change")) closeSheet();
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  // Why the last connect did not go through, until the next one starts: under the switch,
  // where you look (it showed only on the Proxies page's row before).
  const failedWords = phase === "off" && p.error ? p.error.replace(/^Error:\s*/, "") : "";
  const failed = failedWords ? failedWords.charAt(0).toUpperCase() + failedWords.slice(1) : null;
  const health = p.status?.health ?? null;

  // Where the camera goes and the pin stands: the exit's own city once a probe said it; before
  // that the middle of the place's country (as on the phone).
  const probe = health?.ok && on ? health : null;
  const exitAt = probe && known(probe.latitude, probe.longitude) ? ([probe.latitude!, probe.longitude!] as [number, number]) : null;
  const cc = (probe?.country_code ?? p.view?.cc)?.toLowerCase();
  const country = countryOf(cc);
  const target = probe ? (exitAt ?? (country ? centreOf(country) : null)) : country ? centreOf(country) : null;
  const pinCc = probe ? probe.country_code?.toLowerCase() : p.view?.cc?.toLowerCase();
  const pinWords = probe
    ? (probe.city ?? countryName(probe.country_code ?? undefined) ?? undefined)
    : p.view?.cc
      ? countryName(p.view.cc)
      : undefined;

  const width = W || 1000;
  const scale = !target ? WORLD_S : on && exitAt ? CITY_S : on || busy ? countryScale(country, width) : WORLD_S;
  const [flight] = useState(() => new Flight(camOn(20, 10, WORLD_S), width));
  flight.width = width;
  const camKey = target ? `${target[0].toFixed(3)},${target[1].toFixed(3)},${scale.toFixed(2)}` : "world";
  const first = useRef(true);
  useEffect(() => {
    if (!W) return;
    const cam = target ? camOn(target[0], target[1], scale) : camOn(20, 10, WORLD_S);
    // The page opens where it is, then flies from there.
    if (first.current) {
      first.current = false;
      flight.set(cam);
    } else flight.go(cam);
  }, [camKey, W > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // The pin stands on the place the camera goes to and rides the map while it flies there. A new
  // place (the exit's city once a probe has said it, the country when you are off) makes it come
  // up there; only closer or farther, it stays. Read here, in the render that brings the new
  // place's words, so they never show for a frame where the old place was.
  const at = camOn(target?.[0] ?? 20, target?.[1] ?? 10, scale);
  const place = useRef<PinPlace>({ x: at.x, y: at.y, since: -Infinity });
  if (Math.abs(at.x - place.current.x) > 1e-6 || Math.abs(at.y - place.current.y) > 1e-6) {
    place.current = { x: at.x, y: at.y, since: performance.now() };
  }

  // The lit country hands over to the next one: the old one fades out while the new one fades in.
  const fade = useRef<Fade>({ exit: pinCc, start: 0 });
  const [fadeKey, setFadeKey] = useState(0);
  useEffect(() => {
    if (pinCc === fade.current.exit) return;
    fade.current = { exit: pinCc, before: fade.current.exit, start: performance.now() };
    setFadeKey((k) => k + 1);
  }, [pinCc]);

  const px = width / 2;
  // A short window (the smallest is 940 x 600) keeps everything closer together.
  const compact = (H || 700) < 700;
  const py = compact ? Math.max(78, (H || 700) * 0.17) : Math.max(96, (H || 700) * 0.22);
  const pinned = target != null;
  const base = { width, height: H || 700, px, py, pitch: 10, radius: 3.3, pin: pinned };
  const darkScene = useMemo(() => ({ ...base, tone: dark ? TONES.dark : TONES.light, lit: busy }), [width, H, px, py, pinned, dark, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const blueScene = useMemo(() => ({ ...base, tone: TONES.blue, lit: true }), [width, H, px, py, pinned]); // eslint-disable-line react-hooks/exhaustive-deps

  // The blue flood: from where the knob lands, the same map in blue.
  const trackRef = useRef<HTMLButtonElement>(null);
  const [knob, setKnob] = useState({ x: width * 0.6, y: (H || 700) * 0.5 });
  useLayoutEffect(() => {
    const t = trackRef.current;
    const root = rootRef.current;
    if (!t || !root) return;
    const a = t.getBoundingClientRect();
    const b = root.getBoundingClientRect();
    // The knob's centre once on: its right end, inside the track's 8 px rim.
    setKnob({ x: a.right - b.left - 8 - 52, y: a.top - b.top + a.height / 2 });
  }, [W, H]); // eslint-disable-line react-hooks/exhaustive-deps
  const reach = Math.hypot(Math.max(knob.x, width - knob.x), Math.max(knob.y, (H || 700) - knob.y)) * 1.04;
  // The blue layer is there while a connection is on, and leaves once its circle has closed
  // (onTransitionEnd below). It comes in closed and opens one style pass later: a layer that
  // starts at its full size has nothing to grow from, and the page turned blue in one frame
  // (0.3.8). Off, it closes at once, as before. Already on when the page opens: blue at once.
  const floodRef = useRef<HTMLDivElement>(null);
  const [blueUp, setBlueUp] = useState(on);
  const [open, setOpen] = useState(on);
  useEffect(() => {
    if (on) setBlueUp(true);
    else setOpen(false);
  }, [on]);
  useLayoutEffect(() => {
    if (!on || !blueUp || open) return;
    // The closed circle is worked out first, so the transition runs from it.
    floodRef.current?.getBoundingClientRect();
    setOpen(true);
  }, [on, blueUp, open]);

  const state = phase === "off"
    ? "Not connected"
    : phase === "connecting"
      ? "Reaching the proxy"
      : phase === "switching"
        ? "Switching"
        : phase === "rotating"
          ? "Changing the exit"
          : phase === "leaving"
            ? "Disconnecting"
            : p.failing
              ? "Not answering"
              : "Connected";
  const where = on
    ? p.failing
      ? (health?.error ? health.error.charAt(0).toUpperCase() + health.error.slice(1) : "The proxy did not answer")
      : probe
        ? [[probe.city, probe.country ?? countryName(probe.country_code ?? undefined)].filter(Boolean).join(", "), probe.latency_ms != null ? `${probe.latency_ms} ms` : ""].filter(Boolean).join(" · ")
        : "Checking where you appear"
    : busy
      ? "Checking it works"
      : p.view
        ? "Your own address"
        : "Pick where you appear";

  // On, off, or with none of yours Proxies saying to add them first (connection.tsx, toggle).
  const press = p.onToggle;

  return (
    <div ref={rootRef} className="mix" data-on={on || undefined} data-busy={busy || undefined} data-dark={dark || undefined} data-compact={compact || undefined}>
      <MixMap className="mix-map" flight={flight} fade={fade} place={place} fadeKey={fadeKey} scene={darkScene} hidden={on && blueUp && !!W}>
        <Pin on={busy} white={false} cc={pinCc} words={pinWords} dark={dark} />
      </MixMap>

      {blueUp && (
        <div
          ref={floodRef}
          className="mix-flood"
          style={{ clipPath: `circle(${on && open ? reach : 0}px at ${knob.x}px ${knob.y}px)` }}
          onTransitionEnd={() => {
            if (!on) setBlueUp(false);
          }}
        >
          <MixMap className="mix-map" flight={flight} fade={fade} place={place} fadeKey={fadeKey} scene={blueScene}>
            <Pin on white cc={pinCc} words={pinWords} dark={dark} beat={health?.exit_ip ?? undefined} />
          </MixMap>
        </div>
      )}

      <div className="mix-stack" style={{ top: py + (compact ? 46 : 70) }}>
        <div className="mix-state">{state}</div>
        <button
          ref={trackRef}
          type="button"
          className="mix-track"
          data-on={on || undefined}
          data-busy={busy || undefined}
          onClick={press}
          disabled={phase === "leaving"}
          title={w.toggleTitle}
          aria-label={w.toggleTitle}
        >
          <span className="mix-knob">
            <HLetter className="mix-h" gid="mixh" />
          </span>
        </button>
        <div className="mix-ip num">
          {on && probe?.exit_ip ? <DigitRoll text={probe.exit_ip} /> : on && p.failing ? "No answer" : on ? "…" : ""}
        </div>
        {failed ? (
          <div className="mix-where is-bad" role="alert" title={failed}>
            {failed}
          </div>
        ) : phase === "off" && !p.view ? (
          // None of yours yet: the words that ask you to pick are the way to My proxies.
          <button type="button" className="mix-where is-link" onClick={p.onChangeTarget}>
            {where}
          </button>
        ) : (
          <div className="mix-where">{where}</div>
        )}
        {p.ended && (on || busy) && <div className="mix-ended">{p.ended}</div>}
        <div className="mix-stats num" aria-hidden={!on}>
          <span>
            <Icon.download /> {formatRate(p.rate?.down ?? 0)}
          </span>
          <span>
            <Icon.download className="up" /> {formatRate(p.rate?.up ?? 0)}
          </span>
          <span>{w.uptime}</span>
        </div>
      </div>
      {note && <div className="mix-note">{note}</div>}

      <div className="mix-bottom">
        {/* The place: Change opens Quick change (a quick one, or the full list); with none of
            yours, My proxies, where they are added. */}
        <button
          type="button"
          className="mix-place"
          onClick={() => (p.view ? openSheet("change") : p.onChangeTarget())}
          aria-haspopup={p.view ? "dialog" : undefined}
          aria-expanded={p.view ? sheet === "change" : undefined}
        >
          {p.view ? (
            <>
              <span className="mix-tile" data-kind={p.view.kind}>
                {p.view.kind === "free" ? <Icon.bolt /> : p.view.cc ? <Flag cc={p.view.cc} /> : p.view.kind === "group" ? <Icon.layers /> : <Icon.globe />}
              </span>
              <span className="mix-place-words">
                <b>{p.view.name}</b>
                <small>{p.view.sub ?? (p.view.kind === "free" ? "The fastest one there" : "Your proxy")}</small>
              </span>
              <span className="mix-change">
                Change
                <Icon.chevronDown className={sheet === "change" ? undefined : "rotate-180"} />
              </span>
            </>
          ) : (
            <>
              <span className="mix-tile" data-kind="add">
                <Icon.plus />
              </span>
              <span className="mix-place-words">
                <b>Add your proxies</b>
                <small>Paste them or drop a file. Any format.</small>
              </span>
            </>
          )}
        </button>
        <button type="button" className="mix-menu" data-shown={on || undefined} onClick={() => openSheet("menu")} tabIndex={on ? 0 : -1} aria-hidden={!on}>
          <Icon.more />
          <span>Menu</span>
        </button>
      </div>

      {sheet && (
        <div className="mix-scrim" data-leaving={leaving || undefined} onClick={closeSheet}>
          <div
            className="mix-sheet"
            role="dialog"
            aria-label={sheet === "places" ? "Connect to" : sheet === "change" ? "Quick change" : "Menu"}
            onClick={(e) => e.stopPropagation()}
            onAnimationEnd={(e) => {
              if (e.target !== e.currentTarget || e.animationName !== "mix-down") return;
              setSheet(null);
              setLeaving(false);
            }}
          >
            <div className="mix-sheet-head">
              <b>{sheet === "places" ? "Connect to" : sheet === "change" ? "Quick change" : (p.view?.name ?? "Menu")}</b>
              {sheet === "menu" && probe && (
                <small className="num">{[probe.exit_ip, probe.city].filter(Boolean).join(" · ")}</small>
              )}
              {sheet === "change" && changes.line && <small>{changes.line}</small>}
              <button type="button" className="mix-close" onClick={closeSheet} aria-label="Close">
                <Icon.cross />
              </button>
            </div>
            {sheet === "places" ? (
              <div className="mix-sheet-body">{side}</div>
            ) : sheet === "change" ? (
              <div className="mix-sheet-body mix-change-body">
                <ChangeRows list={changes} onDone={closeSheet} />
              </div>
            ) : (
              <Menu p={p} w={w} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** What only a computer has, once you are on: in tiles, as the phone's menu. */
function Menu({ p, w }: { p: ConnectionCardProps; w: ReturnType<typeof connectionWords> }) {
  const health = p.status?.health ?? null;
  const [copied, setCopied] = useState(false);
  const ip = health?.ok ? health.exit_ip : undefined;
  const copyIp = async () => {
    if (!ip) return;
    await copyText(ip).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="mix-sheet-body mix-menu-body">
      <div className="mix-tiles">
        <button type="button" className="mix-tile-btn" onClick={copyIp} disabled={!ip}>
          <span className="mix-tile-ico">
            <Icon.copy />
          </span>
          <b>{copied ? "Copied" : "Copy IP"}</b>
          <small className="num">{ip ?? "Not known yet"}</small>
        </button>
        <button type="button" className="mix-tile-btn" onClick={p.onCopy} disabled={!p.status?.listen}>
          <span className="mix-tile-ico">
            <Icon.laptop />
          </span>
          <b>{p.copied ? "Copied" : "Copy the local address"}</b>
          <small className="num">{p.status?.listen ?? "127.0.0.1"}</small>
        </button>
        <button type="button" className="mix-tile-btn" onClick={p.onProbe} disabled={p.busy}>
          <span className="mix-tile-ico">
            <Icon.refresh />
          </span>
          <b>Test it now</b>
          <small className="num">{health ? (health.ok ? `${health.latency_ms ?? "?"} ms` : "No answer") : "Not tested yet"}</small>
        </button>
        <div className="mix-tile-btn mix-tile-fraud">
          <span className="mix-tile-ico">
            <Icon.shield />
          </span>
          <b>Fraud score</b>
          <small>{p.fraud ? <FraudChip set={p.fraud} /> : "Not looked up"}</small>
        </div>
      </div>
      <section className="mix-section">
        <h3>What sites see</h3>
        {p.leaks?.length ? <LeakCheck rows={p.leaks} onAction={p.onLeakAction} /> : <p className="mix-quiet">Checked once you are connected.</p>}
      </section>
      <section className="mix-section">
        <h3>Programs</h3>
        <SystemProxyRow p={p} w={w} />
      </section>
      <ConnMessages p={p} />
    </div>
  );
}

/** The pin: a dot (a diamond once you are on), two rings that pulse, and its label (the flag
    and the city). Every new address makes the dot hop once. */
function Pin({ on, white, cc, words, dark, beat }: { on: boolean; white: boolean; cc?: string; words?: string; dark: boolean; beat?: string }) {
  const [hop, setHop] = useState(false);
  useEffect(() => {
    if (!beat) return;
    setHop(true);
    const t = setTimeout(() => setHop(false), 40);
    return () => clearTimeout(t);
  }, [beat]);
  return (
    <span className={cx("mix-pin", white && "white", on && "on", !dark && !white && "light")}>
      {on && (
        <>
          <i className="ring" />
          <i className="ring late" />
        </>
      )}
      <i className={cx("dot", hop && "hop")} />
      {words && (
        <span className="label">
          {cc && <Flag cc={cc} />}
          <b>{words}</b>
        </span>
      )}
    </span>
  );
}
