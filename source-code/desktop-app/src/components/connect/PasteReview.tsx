import { Fragment, useEffect, useRef, useState } from "react";
import { useBack } from "../../lib/back";
import { aboutWords, lineParts, proxyTitle, spacedN } from "../../lib/connect";
import { expiryOf, MAX_GROUP_LINES, type Details } from "../../lib/places";
import {
  NAME_EXAMPLES,
  REVIEW_AT_ONCE,
  REVIEW_TESTS,
  addLabels,
  countReview,
  linesToAdd,
  nameExample,
  namesPreview,
  reviewOrder,
  reviewStatus,
  testOf,
  type LineTest,
} from "../../lib/review";
import { checkLine } from "../../lib/tauri";
import { BlockTitle, Button, Flag, Icon, Input, cx } from "../ui";
import { useReadable, useTargeting } from "./lineReading";
import { Speed } from "./PlaceRow";

/* A pasted list, before it is kept (rebuilt 2026-10-18 from the paste lab, rounds 8 to 16).
   Every line is read by the engine's own parser, so what is kept is exactly what will connect,
   the unreadable ones shown with the engine's reason and left out. Then each line is tested the
   way the paste field tests one (check_line), a dozen at a time, the count on top ("9 work · 3
   failed"); Skip testing ends the wait. Then the add step asks: only the ones that work, or all
   of them anyway (a proxy that does not answer may only be down a while), or the lot as one
   group. Adding asks "Name them?": one name for all, numbered, or Skip (2026-10-17: "make it
   clearer that you can name them or you can skip the naming ... it asks you"). What a test found
   stays with the proxy once saved (src-tauri/src/places.rs, `checked`). One day and one note for
   all of them, as before. A batch of sessions shows each session, never the address they share. */

/** The lines tested, REVIEW_AT_ONCE at a time, the first REVIEW_TESTS of them; Skip stops
    starting new ones (the ones under way still land). */
function useReviewTests(lines: string[], enabled: boolean) {
  const [tests, setTests] = useState<ReadonlyMap<string, LineTest>>(() => new Map());
  const [skipped, setSkipped] = useState(false);
  const skip = useRef(false);
  const key = lines.join("\n");
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const queue = lines.slice(0, REVIEW_TESTS);
    const work = async () => {
      while (queue.length && !cancelled && !skip.current) {
        const l = queue.shift()!;
        let t: LineTest;
        try {
          t = testOf(await checkLine(l));
        } catch (e) {
          t = { ok: false, why: e instanceof Error ? e.message : String(e) };
        }
        if (cancelled) return;
        setTests((m) => new Map(m).set(l, t));
      }
    };
    void Promise.all(Array.from({ length: REVIEW_AT_ONCE }, work));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return {
    tests,
    skipped,
    skip: () => {
      skip.current = true;
      setSkipped(true);
    },
  };
}

export default function PasteReview({
  lines,
  room,
  onCancel,
  onAdd,
  onGroup,
}: {
  lines: string[];
  /** How many more proxies can be saved. */
  room: number;
  onCancel: () => void;
  /** The lines kept, what goes on every one of them (a day, a note), and one name for all of
      them, numbered (none: they keep their addresses). */
  onAdd: (lines: string[], details?: Details, name?: string) => void;
  onGroup: (lines: string[], details?: Details) => void;
}) {
  // A phone's Back leaves the review, as Cancel does.
  useBack(true, onCancel);
  const { read, done } = useReadable(lines);
  const ok = lines.filter((l) => read.get(l) === true);
  const bad = lines.filter((l) => typeof read.get(l) === "string");
  const { tests, skipped, skip } = useReviewTests(ok, done);
  const count = countReview(ok, tests, skipped);
  const settled = done && count.settled;
  // Once settled: the ones that work, the untested, the failed, then the unreadable.
  const order = done ? [...reviewOrder(ok, tests, settled), ...bad] : lines;
  const shown = order.slice(0, 150);
  const targeting = useTargeting(shown);
  const labels = addLabels(count);
  const mainLines = linesToAdd(ok, tests, labels.mainTakesFailed);
  // "N don't work right now" stands over the first that failed, when some worked.
  const firstFailed = settled && count.failed && count.failed < count.n ? shown.find((l) => tests.get(l)?.ok === false) : undefined;

  // A batch is bought together and ends together: one day and one note for all of it.
  const [day, setDay] = useState("");
  const [note, setNote] = useState("");
  const details = (): Details | undefined =>
    day || note.trim() ? { expires: day || undefined, note: note.trim() || undefined } : undefined;
  const left = expiryOf(day || undefined);
  // The add button pressed, while "Name them?" asks.
  const [naming, setNaming] = useState<string[] | null>(null);

  const status = !done
    ? `reading ${spacedN(lines.length)} lines`
    : !ok.length
      ? "none can be read"
      : `${reviewStatus(count)}${bad.length ? ` · ${spacedN(bad.length)} unreadable` : ""}`;

  return (
    <div className="flex flex-col gap-3">
      {naming && (
        <NameThem
          count={naming.length}
          onBack={() => setNaming(null)}
          onAdd={(name) => {
            onAdd(naming, details(), name);
            setNaming(null);
          }}
        />
      )}
      <BlockTitle name={`${spacedN(lines.length)} proxies pasted`} value={status} />
      {/* As tall as the window allows, never under 330 px. */}
      <div className="ux-dests max-h-[max(330px,calc(100vh-400px))] overflow-y-auto rounded-[14px] bg-[var(--well)] p-1.5">
        {shown.map((l) => {
          const r = read.get(l);
          const t = tests.get(l);
          const parts = lineParts(l);
          const about = targeting.get(l) ?? null;
          const waiting = r === true && !t && !skipped && ok.indexOf(l) < REVIEW_TESTS;
          const said = aboutWords(about) || (parts.user ? `login ${parts.user}` : "no login");
          return (
            <Fragment key={l}>
              {l === firstFailed && (
                <p className="ux-review-failed">
                  {count.failed === 1 ? "1 doesn't work right now" : `${spacedN(count.failed)} don't work right now`}
                </p>
              )}
              <div className="ux-dest !min-h-[44px]">
                <span className="pick !cursor-default">
                  {t?.ok && t.cc ? (
                    <span className="lead is-flag">
                      <Flag cc={t.cc} />
                    </span>
                  ) : (
                    <span className={cx("lead", t?.ok ? "is-ok" : typeof r === "string" || t?.ok === false ? "is-bad" : "")}>
                      {typeof r === "string" || t?.ok === false ? <Icon.cross /> : t?.ok ? <Icon.check /> : r === true && !waiting ? <Icon.globe /> : <Icon.clock />}
                    </span>
                  )}
                  <span className="text">
                    <span className="name num">{proxyTitle({ address: parts.address, about })}</span>
                    <span className="sub">
                      {typeof r === "string" ? (
                        <span className="bad">{r}</span>
                      ) : t?.ok === false ? (
                        <span className="bad">{t.why ? t.why.charAt(0).toUpperCase() + t.why.slice(1) : "Not answering"}</span>
                      ) : t?.ok ? (
                        [t.place, said].filter(Boolean).join(" · ")
                      ) : waiting ? (
                        "Testing…"
                      ) : (
                        said
                      )}
                    </span>
                  </span>
                  {t?.ok && t.ms != null && <Speed ms={t.ms} />}
                </span>
              </div>
            </Fragment>
          );
        })}
        {lines.length > shown.length && <p className="px-3 py-2 text-[13px] font-medium text-ink-mute">and {spacedN(lines.length - shown.length)} more</p>}
      </div>
      {ok.length > REVIEW_TESTS && (
        <p className="px-1 text-[12.5px] font-medium text-ink-mute">
          The first {spacedN(REVIEW_TESTS)} are tested here; the Checker tests any number.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-[190px_minmax(0,1fr)]">
        <label className="flex flex-col gap-1">
          <span className="px-1 text-[12.5px] font-semibold text-ink-mute">
            Expires on{left ? ` · ${left.words}` : ", if they do"}
          </span>
          <Input type="date" value={day} onChange={setDay} label="Expires on, for all of them" />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="px-1 text-[12.5px] font-semibold text-ink-mute">Note for all of them</span>
          <Input value={note} onChange={setNote} placeholder="Where they are from, what they are for" label="Note for all of them" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {done && ok.length > 0 && !settled ? (
          <Button onClick={skip} title="Add them now; the ones not tested yet are tested in your list">
            Skip testing
          </Button>
        ) : (
          <>
            <Button
              variant="solid"
              disabled={!done || mainLines.length === 0 || mainLines.length > room}
              onClick={() => setNaming(mainLines)}
              title="Each line becomes its own saved proxy"
            >
              <Icon.plus className="h-4 w-4" />
              {done && ok.length ? labels.main : "Add them"}
            </Button>
            {labels.anyway && (
              <Button disabled={ok.length > room} onClick={() => setNaming(ok)} title="The ones that did not answer too: they may only be down a while">
                {labels.anyway}
              </Button>
            )}
            <Button disabled={!done || mainLines.length === 0} onClick={() => onGroup(mainLines, details())} title="One group you connect to in one click">
              <Icon.layers className="h-4 w-4" />
              Make them one group
            </Button>
          </>
        )}
        <Button variant="text" onClick={onCancel}>
          Cancel
        </Button>
        {settled && mainLines.length > room && (
          <span className="text-[13px] font-semibold text-warn">
            Room for {spacedN(Math.max(0, room))} more saved proxies; a group holds up to {spacedN(MAX_GROUP_LINES)}.
          </span>
        )}
      </div>
    </div>
  );
}

/** "Name them?" when adding (2026-10-17, the lab's round 13): one name for all of them,
    numbered, or Skip, which keeps their addresses as names; any one can be named later in the
    list. The box shows a real example, a different one each time (round 16). The page behind
    dims: the one see-through thing kept, the page behind an open dialog. */
function NameThem({ count, onBack, onAdd }: { count: number; onBack: () => void; onAdd: (name?: string) => void }) {
  const [name, setName] = useState("");
  const [seed] = useState(() => Math.floor(Math.random() * NAME_EXAMPLES.length));
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => box.current?.focus(), []);
  // Escape goes back to the review, and stops there.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onBack();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onBack]);
  const label = name.trim();
  const one = count === 1;
  return (
    <>
      <div className="ux-dialog-scrim" data-scrim="true" onClick={onBack} />
      <div className="ux-dialog rise-in" role="dialog" aria-modal="true" aria-label={one ? "Name it" : "Name them"}>
        <div className="flex items-center gap-2">
          <b className="text-[19px] font-bold text-ink">{one ? "Name it?" : "Name them?"}</b>
          <span className="ux-optional">Optional</span>
        </div>
        <p className="text-[13.5px] font-medium text-ink-mute">
          {one ? "A name says what it is for. Or skip it and name it any time later." : "One name for all of them, numbered. Or skip it and name them any time later."}
        </p>
        <label className="flex flex-col gap-1">
          <span className="px-1 text-[12.5px] font-semibold text-ink-mute">{one ? "Its name" : "One name for all, numbered"}</span>
          <Input
            inputRef={box}
            value={name}
            onChange={(v) => setName(v.slice(0, 60))}
            placeholder={nameExample(seed)}
            label={one ? "Its name" : "One name for all, numbered"}
            onKeyDown={(e) => e.key === "Enter" && onAdd(label || undefined)}
          />
        </label>
        <p className="num px-1 text-[13px] font-semibold text-ink-mute">
          {label ? namesPreview(label, count) : one ? "It keeps its address as its name." : "They keep their addresses as names."}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="text" onClick={onBack}>
            Back
          </Button>
          <Button onClick={() => onAdd()}>Skip</Button>
          <Button variant="solid" disabled={!label} onClick={() => onAdd(label)}>
            <Icon.plus className="h-4 w-4" />
            {one ? "Add it with this name" : `Add ${spacedN(count)} with names`}
          </Button>
        </div>
      </div>
    </>
  );
}
