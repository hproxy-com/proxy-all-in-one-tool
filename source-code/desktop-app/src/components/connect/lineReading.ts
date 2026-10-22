import { useEffect, useMemo, useRef, useState } from "react";
import { listLines } from "../../lib/connect";
import { describeLines, parseLine, type Targeting } from "../../lib/tauri";

/* Pasted lines, read by the engine before anything is kept: for the paste review
   (PasteReview.tsx), the group editor (Destinations.tsx) and Add's box (AddProxies.tsx). */

/** Past this many lines Add's box counts without reading them; the review reads them all. */
const BOX_READ_MAX = 5000;

export type BoxLines = {
  /** Every line in the box, once each: what goes to the review. */
  lines: string[];
  /** The lines the engine read as proxies so far. */
  ready: number;
};

/** What is in Add's box, read as it is typed (2026-10-22): only the lines the engine reads as
    proxies count, so a header or a half-typed line never shows as "ready to test". A line not
    read yet does not count, so the words never jump while typing. A line that is not a proxy
    blocks nothing: the review says so and leaves it out. */
export function useBoxLines(text: string): BoxLines {
  const lines = useMemo(() => [...new Set(listLines(text))], [text]);
  const reading = lines.length <= BOX_READ_MAX;
  const { read } = useReadable(lines, reading);
  if (!reading) return { lines, ready: lines.length };
  return { lines, ready: lines.filter((l) => read.get(l) === true).length };
}

/** Every line read by the engine's own parser, a dozen at a time: `true`, or
    the parser's reason it cannot be read. Answers are kept per line, so typing
    into a list only reads the lines that changed. */
export function useReadable(lines: string[], enabled = true): { read: Map<string, true | string>; done: boolean } {
  const cache = useRef(new Map<string, true | string>());
  const [, bump] = useState(0);
  const key = lines.join("\n");
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const queue = [...new Set(lines)].filter((l) => !cache.current.has(l));
    if (!queue.length) return;
    let since = 0;
    const work = async () => {
      while (queue.length && !cancelled) {
        const l = queue.shift()!;
        try {
          await parseLine(l);
          cache.current.set(l, true);
        } catch (e) {
          cache.current.set(l, e instanceof Error ? e.message : String(e));
        }
        if (++since >= 25) {
          since = 0;
          if (!cancelled) bump((n) => n + 1);
        }
      }
      if (!cancelled) bump((n) => n + 1);
    };
    const t = setTimeout(() => void Promise.all(Array.from({ length: 12 }, work)), 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return { read: cache.current, done: lines.every((l) => cache.current.has(l)) };
}

/** What each of `lines` targets (a session, a region), asked of the engine in
    one call (src-tauri/src/places.rs). Empty until it answers. */
export function useTargeting(lines: string[]): Map<string, Targeting | null> {
  const [found, setFound] = useState(() => new Map<string, Targeting | null>());
  const key = lines.join("\n");
  useEffect(() => {
    let live = true;
    void describeLines(lines)
      .then((about) => live && setFound(new Map(lines.map((l, i) => [l, about[i] ?? null] as const))))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return found;
}
