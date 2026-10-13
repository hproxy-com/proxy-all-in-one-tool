import { useState } from "react";
import { loadRuns, clearRuns, type RunRecord } from "../lib/history";
import { isMobile, thisDevice } from "../lib/tauri";
import { Button, Card, Icon, InfoTip, PageHead, cx } from "./ui";

/* History, in look D (2026-09-23): one filled panel, one row per run the way
   the checker draws its rows. A bar at the start says how the run went (green
   when most worked, amber when some did, red when almost none did), then the
   count, how long it took and when. Counts only: the addresses are never kept.
   Inside the Checker since 2026-10-02: Back returns to the box. On a phone
   the top bar names the page and holds the way back, so the card starts
   with the "i" and Clear history. */

const spaced = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

function tone(rate: number): string {
  return rate >= 60 ? "tone-ok" : rate >= 25 ? "tone-warn" : "tone-danger";
}

export default function History({ onBack }: { onBack?: () => void }) {
  const [runs, setRuns] = useState<RunRecord[]>(() => loadRuns());
  const info = `Your last checks on ${thisDevice()}. Counts only: the addresses are never kept.`;
  const clear =
    runs.length > 0 ? (
      <Button
        variant="text"
        onClick={() => {
          clearRuns();
          setRuns([]);
        }}
      >
        Clear history
      </Button>
    ) : undefined;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[980px] px-6 pb-8 pt-1.5 max-sm:px-3">
        <Card tone="flat" pad="roomy">
          {onBack && (
            <button type="button" className="ux-link mb-3" onClick={onBack}>
              <Icon.arrowRight className="h-3.5 w-3.5 rotate-180" /> Checker
            </button>
          )}
          {isMobile() ? (
            <div className="flex min-h-[34px] items-center justify-between gap-3">
              <InfoTip label="History">{info}</InfoTip>
              {clear}
            </div>
          ) : (
            <PageHead title="History" info={info} aside={clear} />
          )}

          {runs.length === 0 ? (
            <div className="mt-6 rounded-[14px] bg-[var(--well)] p-8 text-center">
              <p className="text-[15px] font-bold text-ink">No checks yet</p>
            </div>
          ) : (
            <div className="mt-6 overflow-hidden rounded-[14px] bg-[var(--well)]">
              {runs.map((r, i) => {
                const rate = r.total ? Math.round((r.alive / r.total) * 100) : 0;
                return (
                  <div key={i} className="flex items-center gap-4 border-t border-[var(--card-solid)] px-4 py-3 first:border-t-0 max-sm:flex-wrap max-sm:gap-x-3 max-sm:gap-y-1">
                    <i className={cx("ux-bar", tone(rate))} />
                    <p className="num min-w-0 flex-1 text-[15px] font-bold text-ink">
                      {spaced(r.alive)}
                      <span className="font-semibold text-ink-soft"> of {spaced(r.total)}</span> working
                    </p>
                    <span className={cx("num w-20 text-right text-[14px] font-bold", rate >= 60 ? "text-ok" : rate >= 25 ? "text-warn" : "text-danger")}>{rate}%</span>
                    <span className="num w-16 text-right text-[13.5px] font-semibold text-ink-mute">{(r.durationMs / 1000).toFixed(1)} s</span>
                    <span className="num w-44 text-right text-[13.5px] font-semibold text-ink-mute max-sm:w-auto">{new Date(r.ts).toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
