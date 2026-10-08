import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import HLetter from "./HLetter";
import { Button } from "./ui";
import { getGateView, openApp, runStartGate, share, sizeLine, subscribeGate, type GateView } from "../lib/startGate";
import { channelWay } from "../lib/versions";

/* The start (lib/startGate.ts): a newer version first, then the app. The screens appear only
   when the look takes more than a moment or finds something; most starts go straight through.
   The title bar stays above it, so the window can always be closed or moved. */
export default function StartGate({ children }: { children: ReactNode }) {
  const view = useSyncExternalStore(subscribeGate, getGateView, getGateView);
  useEffect(() => {
    void runStartGate();
  }, []);
  if (view.stage === "open") return <>{children}</>;
  return <StartScreen view={view} />;
}

function StartScreen({ view }: { view: Exclude<GateView, { stage: "open" }> }) {
  // The first moment of a look draws nothing but the page itself.
  if (view.stage === "waiting") return <div className="h-full bg-canvas" />;

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-canvas px-6 py-10">
      <div className="rise-in w-full max-w-[440px]">
        <HLetter fill="blue" gid="gate" className="h-9 w-auto" />
        <Body view={view} />
      </div>
    </div>
  );
}

function Body({ view }: { view: Exclude<GateView, { stage: "open" | "waiting" }> }) {
  switch (view.stage) {
    case "checking":
      return (
        <>
          <Title>Looking for a new version</Title>
          <Line>HProxy opens in a moment.</Line>
          <Bar share={null} />
        </>
      );

    case "downloading": {
      const size = sizeLine(view.progress);
      return (
        <>
          <Title>Updating HProxy</Title>
          <Line>
            <span className="num">
              {view.info.currentVersion} to {view.info.version}
            </span>
            {size ? <span className="num"> · {size}</span> : null}
          </Line>
          <Bar share={share(view.progress)} />
          <Notes text={view.info.notes} />
          <Small>The new version opens by itself when it is installed. Your saved proxies and settings stay.</Small>
        </>
      );
    }

    case "installing":
      return (
        <>
          <Title>Installing {view.info.version}</Title>
          <Line>HProxy closes for a moment and opens again by itself.</Line>
          <Bar share={1} />
          <Notes text={view.info.notes} />
        </>
      );

    case "store":
      return (
        <>
          <Title>Updating in the Microsoft Store</Title>
          <Line>Finish in the Microsoft Store window. HProxy opens again when the update is installed.</Line>
          <Bar share={null} />
          <div className="mt-6">
            <Button onClick={openApp}>Open without updating</Button>
          </div>
        </>
      );

    case "new-version": {
      const way = channelWay(view.channel);
      const { verdict } = view;
      return (
        <>
          <Title>Version {verdict.newer} is out</Title>
          <Line>
            <span className="num">You have {verdict.current}</span>
            {verdict.date ? <span className="num"> · released {verdict.date.slice(0, 10)}</span> : null}
          </Line>
          {verdict.required && (
            <p className="mt-4 text-[15px] font-bold text-danger">
              Your version no longer works as it should. Update to keep using HProxy.
            </p>
          )}
          <Notes text={verdict.notes} />
          {way && <Small>{way.line}</Small>}
          <div className="mt-6 flex flex-wrap items-center gap-2">
            {way && (
              <Button variant="solid" size="lg" onClick={() => void way.run()}>
                {way.button}
              </Button>
            )}
            <Button size="lg" onClick={openApp}>
              Open anyway
            </Button>
          </div>
        </>
      );
    }
  }
}

function Title({ children }: { children: ReactNode }) {
  return <h1 className="mt-6 text-[26px] font-black leading-tight text-ink">{children}</h1>;
}

function Line({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[15px] font-bold text-ink-mute">{children}</p>;
}

function Small({ children }: { children: ReactNode }) {
  return <p className="mt-5 text-[14px] font-semibold leading-relaxed text-ink-mute">{children}</p>;
}

/* What changed: the release notes, a few lines, scrolling when longer. */
function Notes({ text }: { text?: string | null }) {
  if (!text) return null;
  return (
    <p className="mt-5 max-h-40 overflow-y-auto whitespace-pre-wrap border-t border-hairline pt-4 text-[14px] font-semibold leading-relaxed text-ink-mute">
      {text}
    </p>
  );
}

/* The bar: a solid track and a solid blue fill (nothing see-through, anywhere). Without a share
   it runs a blue segment back and forth: working, size unknown. */
function Bar({ share: part }: { share: number | null }) {
  return (
    <div
      className="relative mt-6 h-2.5 w-full overflow-hidden rounded-full bg-raised"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={part === null ? undefined : Math.round(part * 100)}
    >
      {part === null ? (
        <div className="gate-sweep absolute inset-y-0 w-1/3 rounded-full bg-digi" />
      ) : (
        <div className="h-full rounded-full bg-digi transition-[width] duration-300" style={{ width: `${Math.round(part * 100)}%` }} />
      )}
    </div>
  );
}
