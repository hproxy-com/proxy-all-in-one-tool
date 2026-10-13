import { useEffect, useState } from "react";
import { checkLine, parseLine, type ParsedLine } from "../../lib/tauri";
import type { CheckResult } from "../../lib/checker";
import { verdictOf, type Verdict } from "../../lib/connect";

/* The paste field's line, read and checked as it is typed: first the
   engine's parser ("host 1.2.3.4, port 8080, with login" or the exact reason
   it cannot be read), then one real probe a moment after the line settles. */

/** How long after the line settles before it is checked for real. */
const PRECHECK_DELAY_MS = 700;
/** How long after a key before the line is read. */
const PARSE_DELAY_MS = 120;

export type Precheck =
  | { state: "idle" }
  | { state: "checking"; line: string }
  | { state: "done"; line: string; result: CheckResult; verdict: Verdict };

export function useLineCheck(line: string) {
  const [parsed, setParsed] = useState<ParsedLine | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [precheck, setPrecheck] = useState<Precheck>({ state: "idle" });
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    const t = line.trim();
    if (!t) {
      setParsed(null);
      setParseError(null);
      return;
    }
    let cancelled = false;
    const h = setTimeout(() => {
      parseLine(t)
        .then((p) => {
          if (cancelled) return;
          setParsed(p);
          setParseError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setParsed(null);
          setParseError(String(e));
        });
    }, PARSE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [line]);

  // The probe, location included. Its answer stays with the proxy when it is
  // saved (src-tauri/src/places.rs, `checked`). A dead answer never blocks Add
  // or Connect: the person may know something the probe does not.
  useEffect(() => {
    if (!parsed) {
      setPrecheck({ state: "idle" });
      return;
    }
    const t = line.trim();
    let cancelled = false;
    const h = setTimeout(() => {
      setPrecheck({ state: "checking", line: t });
      checkLine(t)
        .then((result) => {
          if (cancelled) return;
          setPrecheck({ state: "done", line: t, result, verdict: verdictOf(result) });
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          const result: CheckResult = { input: t, alive: false, error: String(e) };
          setPrecheck({ state: "done", line: t, result, verdict: verdictOf(result) });
        });
    }, PRECHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
    // The line is read through `parsed`: a new parse is a new line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, recheck]);

  // The verdict only while it is about the line in the field.
  const verdict = precheck.state === "done" && precheck.line === line.trim() ? precheck.verdict : null;

  return {
    parsed,
    parseError,
    checking: precheck.state === "checking",
    verdict,
    /** Check the same line again. */
    recheck: () => setRecheck((n) => n + 1),
  };
}
