import type { ReactNode } from "react";
import type { ConnectDesign } from "../../lib/look";
import { Button, Flag, Icon, Switch } from "../ui";
import ConnectionCard, {
  ConnMessages,
  ConnStatus,
  LeakCheck,
  ProgramSettings,
  SystemProxyRow,
  TargetRow,
  busyPhase,
  changing,
  connectionWords,
  type ConnectionCardProps,
  type ConnPart,
} from "./ConnectionCard";
import MixConnect from "./mix/MixConnect";

/* The Connect page, laid out five more ways: Mix (the phone app's look, ./mix/), Hero, Map, Bar
   and Split, beside the page as it was (Card, drawn by ConnectPanel.tsx itself). All six are made of the same pieces (ConnectionCard.tsx), so the
   words, the buttons and what they do are the same everywhere; only where
   things sit and how they look changes (styles/connect-designs.css).
   Settings, "Connect page" picks one; `?design=` shows one in the browser
   preview without saving it. */

export type DesignProps = {
  card: ConnectionCardProps;
  /** Beside the connection: the recent places (RecentPlaces.tsx), placed by each design. */
  side: ReactNode;
  /** Under the connection in the browser preview: the relay is pretend there. */
  note?: ReactNode;
};

export default function ConnectDesignView({ design, ...props }: DesignProps & { design: Exclude<ConnectDesign, "card"> }) {
  switch (design) {
    case "mix":
      return <MixConnect {...props} />;
    case "hero":
      return <Hero {...props} />;
    case "map":
      return <MapDesign {...props} />;
    case "bar":
      return <Bar {...props} />;
    case "split":
      return <Split {...props} />;
  }
}

const live = ({ p, w }: ConnPart) => (w.on || changing(p.phase)) && !!p.status;

/** The rows under the connection, for the designs that show the live numbers
    and the buttons somewhere else: where it goes, the leak check, what the
    last action said, and the system proxy. */
function Details({ p, w, routeShown = true }: ConnPart & { routeShown?: boolean }) {
  return (
    <>
      <TargetRow p={p} w={w} routeShown={routeShown} />
      {w.on && p.leaks && <LeakCheck rows={p.leaks} onAction={p.onLeakAction} />}
      <ConnMessages p={p} />
      {w.on && p.status && !p.status.system_proxy && <ProgramSettings listen={p.status.listen ?? ""} phone={w.phone} steps={p.manualSteps} />}
      <SystemProxyRow p={p} w={w} />
    </>
  );
}

/* 2 · Hero: one column, like a VPN app. The route with a big H is the middle
   of the page and the H is the switch; where to go comes under it. */
function Hero({ card, side, note }: DesignProps) {
  return (
    <div className="ux-design mx-auto flex max-w-[780px] flex-col gap-4 px-6 pb-8 pt-1.5 max-sm:px-3" data-design="hero">
      <ConnectionCard {...card} hub="button" />
      {note}
      {side}
    </div>
  );
}

/* 3 · Map: the world across the top of the page, the country you appear in
   lit, the live numbers and the buttons under it; the details and where to go
   side by side below. */
function MapDesign({ card, side, note }: DesignProps) {
  const p: ConnectionCardProps = { ...card, look: "map" };
  const w = connectionWords(p);
  return (
    <div className="ux-design mx-auto flex max-w-[1180px] flex-col gap-4 px-6 pb-8 pt-1.5 max-sm:px-3" data-design="map">
      <div className="ux-connpanel">
        <ConnStatus p={p} w={w} />
      </div>
      {note}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="ux-connpanel">
          <Details p={p} w={w} />
        </div>
        <div className="min-w-0">{side}</div>
      </div>
    </div>
  );
}

/* 4 · Bar: one line on top says everything (the state, where you appear, the
   live numbers, the buttons and the switch); your proxies get the most room
   under it, the details beside them. */
function Bar({ card, side, note }: DesignProps) {
  const p = card;
  const w = connectionWords(p);
  const h = w.health;
  const up = live({ p, w });
  return (
    <div className="ux-design mx-auto flex max-w-[1180px] flex-col gap-4 px-6 pb-8 pt-1.5 max-sm:px-3" data-design="bar">
      <section className="ux-conn ux-statusbar" data-phase={p.phase} data-failing={p.failing || undefined}>
        <div className="state">
          <span className="ux-live">
            <i /> {w.label}
          </span>
          <span className="where">
            {w.exitFlag && <Flag cc={w.exitFlag} />}
            <b>{w.headline}</b>
          </span>
          <span className="sub num">{w.sub}</span>
        </div>
        {up && (
          <dl className="numbers num">
            <div>
              <dt>Round trip</dt>
              <dd className={p.failing ? "text-danger" : undefined}>
                {h ? (h.ok ? `${h.latency_ms ?? "?"} ms` : "No answer") : "…"}
                <button type="button" className="ux-iconlink" disabled={p.busy} onClick={p.onProbe} title="Test the connection now" aria-label="Test the connection now">
                  <Icon.refresh />
                </button>
              </dd>
            </div>
          </dl>
        )}
        <div className="actions">
          {up && w.source?.can_rotate && (
            <Button size="sm" disabled={p.busy} onClick={p.onRotate} title="Move to the next proxy in the group, or a fresh free exit">
              <Icon.refresh className="h-4 w-4" />
              New IP
            </Button>
          )}
          <Switch
            on={w.lit}
            busy={busyPhase(p.phase)}
            disabled={p.busy}
            onChange={p.onToggle}
            label="Connection"
            title={w.toggleTitle}
          />
        </div>
      </section>
      {note}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="ux-connpanel">
          <Details p={p} w={w} routeShown={false} />
        </div>
        <div className="min-w-0 lg:sticky lg:top-1.5">{side}</div>
      </div>
    </div>
  );
}

/* 5 · Split: the connection on a panel of solid HProxy blue on the left,
   blue whether connected or not, with the big H as its switch; the details
   and where to go on the right. */
function Split({ card, side, note }: DesignProps) {
  // The Blue card look's connected face (a white H button with a blue H and
  // white rings) is the one that reads on blue, so the panel wears it.
  const p: ConnectionCardProps = { ...card, hub: "button", look: "card" };
  const w = connectionWords(p);
  return (
    <div
      className="ux-design mx-auto grid max-w-[1180px] items-start gap-4 px-6 pb-8 pt-1.5 max-sm:px-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]"
      data-design="split"
    >
      <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-1.5">
        <div className="ux-connpanel ux-bluepanel">
          <ConnStatus p={p} w={w} />
        </div>
        {note}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="ux-connpanel">
          <Details p={p} w={w} />
        </div>
        {side}
      </div>
    </div>
  );
}
