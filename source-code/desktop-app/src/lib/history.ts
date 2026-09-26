/* Lightweight run history (localStorage). Just enough to answer "what did I
   check and when", capped so it never grows unbounded. */

export type RunRecord = {
  ts: number;
  total: number;
  alive: number;
  durationMs: number;
};

const KEY = "hproxy-checker-history";
const CAP = 50;

export function loadRuns(): RunRecord[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]") as RunRecord[];
  } catch {
    return [];
  }
}

export function addRun(r: RunRecord): void {
  const all = [r, ...loadRuns()].slice(0, CAP);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

export function clearRuns(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
