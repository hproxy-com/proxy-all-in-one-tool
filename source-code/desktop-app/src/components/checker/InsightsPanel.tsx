/* What this machine has learned, shown under the paste area once there is
 * something true to say.
 *
 * It answers a question no single run can: across everything you have ever
 * checked, which providers are actually worth your time. It renders nothing at
 * all until there is enough to say. An analytics panel that appears on first
 * launch showing zeroes teaches the user to ignore that corner forever.
 */

import { useMemo } from "react";
import { insights, loadStats, percentile, rankedNetworks } from "../../lib/insights";
import { thisDevice } from "../../lib/tauri";
import { BlockTitle, Card, Tag } from "../ui";

/** Rows in the network table. More than this and it stops being a summary, and
    every row here is a row taken from the paste area above it. */
const TOP_N = 4;

export function InsightsPanel() {
  /* Read once per mount. The store only changes when a run finishes, and a run
     finishing unmounts this panel (the results screen replaces it). */
  const { lines, networks, runs } = useMemo(() => {
    const stats = loadStats();
    return {
      lines: insights(stats),
      networks: rankedNetworks(stats).slice(0, TOP_N),
      runs: stats.runs,
    };
  }, []);

  if (lines.length === 0 && networks.length === 0) return null;

  return (
    <Card pad="normal" enter>
      <BlockTitle name="What you have learned so far" value={`${runs} ${runs === 1 ? "run" : "runs"} on this machine`} />

      {lines.length > 0 && (
        <ul className="stagger mt-4 flex flex-col gap-1.5">
          {lines.map((i) => (
            <li key={i.kind} className="text-[14px] font-bold text-ink">
              {i.text}{" "}
              {/* The sample is shown next to every claim on purpose. A number
                  with no denominator is how an analytics panel earns distrust. */}
              <span className="num text-ink-mute">({i.sample} proxies)</span>
            </li>
          ))}
        </ul>
      )}

      {networks.length > 1 && (
        <div className="mt-4 flex flex-col">
          {networks.map((n) => {
            const median = percentile(n.hist, 0.5);
            const rate = Math.round(n.rate * 100);
            return (
              <div key={n.asn} className="ux-divider flex items-center gap-4 border-t py-2.5 text-[14px] font-bold">
                <span className="min-w-0 flex-1 truncate text-[15px] font-extrabold text-ink">{n.org}</span>
                <span className="num shrink-0 text-ink-mute">{median ? `${median} ms` : ""}</span>
                {/* Hit rate carries the tone: it is the number that decides
                    whether a provider is worth buying from again. */}
                <Tag tone={rate >= 60 ? "ok" : rate >= 25 ? "warn" : "danger"}>{rate}% alive</Tag>
                <span className="num w-10 shrink-0 text-right text-ink-mute">{n.seen}</span>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 text-[13px] font-bold text-ink-mute">Counts and timings only, kept on {thisDevice()}. Never the addresses themselves.</p>
    </Card>
  );
}
