import { useState } from "react";
import { loadRuns, clearRuns, type RunRecord } from "../lib/history";
import { thisDevice } from "../lib/tauri";
import { Button, Card, PageHead, cx } from "./ui";

/* History, in look D (2026-09-23): one filled panel, one row per run the way
   the checker draws its rows. A bar at the start says how the run went (green
   when most worked, amber when some did, red when almost none did), then the
   count, how long it took and when. Counts only: the addresses are never kept. */

const spaced = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

function tone(rate: number): string {
  return rate >= 60 ? "tone-ok" : rate >= 25 ? "tone-warn" : "tone-danger";
}

export default function History() {
  const [runs, setRuns] = useState<RunRecord[]>(() => loadRuns());

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[980px] px-6 pb-8 pt-1.5 max-sm:px-3">
        <Card pad="roomy">
          <PageHead
            title="History"
            sub={
              runs.length
                ? `Your last ${runs.length} ${runs.length === 1 ? "run" : "runs"} on ${thisDevice()}. Counts only, never the addresses.`
                : "Every list you check shows up here. Counts only, never the addresses."
            }
            aside={
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
              ) : undefined
            }
          />

          {runs.length === 0 ? (
            <div className="mt-6 rounded-[14px] bg-[var(--well)] p-8 text-center">
              <p className="text-[15px] font-bold text-ink">No runs yet</p>
              <p className="mt-1 text-[13.5px] font-medium text-ink-mute">Check a list and it shows up here.</p>
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
