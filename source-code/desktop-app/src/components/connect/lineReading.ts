import { useEffect, useRef, useState } from "react";
import { describeLines, parseLine, type Targeting } from "../../lib/tauri";

/* Pasted lines, read by the engine before anything is kept: for the paste review
   (PasteReview.tsx) and the group editor (Destinations.tsx). */

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
