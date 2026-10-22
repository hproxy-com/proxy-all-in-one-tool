import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  DEFAULT_ROTATION,
  ROTATION_HINT,
  aboutWords,
  ROTATION_RULES,
  SAVED_SORTS,
  formatAgo,
  groupWords,
  isSavedSort,
  listLines,
  matchSaved,
  mergeLines,
  proxyTitle,
  sortSaved,
  spacedN,
  takesN,
  withoutLines,
  type SavedSort,
  type Verdict,
} from "../../lib/connect";
import {
  capitalized,
  countryChoices,
  countWords,
  ensureFreeCountries,
  ensureFreeRun,
  failedRows,
  freeCountriesState,
  freeRun,
  matchCountries,
  onFreeCountries,
  onFreeRuns,
  rowPlace,
  rowWhere,
  runWords,
  testsLeft,
  workingRows,
  type CountriesState,
  type CountryChoice,
  type FreeRow,
  type FreeRun,
} from "../../lib/freeList";
import {
  dayWords,
  expiryOf,
  freeGroupName,
  lastCheckWords,
  MAX_GROUP_LINES,
  MAX_NOTE,
  MAX_PROXIES,
  samePlace,
  todayHere,
  type Details,
  type GroupInput,
  type GroupView,
  type MemberView,
  type Place,
  type ProxyView,
  type Rule,
} from "../../lib/places";
import {
  copyText,
  freeCountries,
  freeList,
  freeTest,
  importProxyFile,
  isMobile,
  openExternal,
  placesGroupLines,
  placesGroupMembers,
  thisDevice,
  type ParsedLine,
} from "../../lib/tauri";
import { useBack } from "../../lib/back";
import { AddProxies } from "./AddProxies";
import { UNDO_MS, type PendingRemove } from "../../lib/undoRemove";
import { useReadable } from "./lineReading";
import PasteReview from "./PasteReview";
import { BlockTitle, Button, ButtonGroup, Dropdown, Flag, Icon, InfoTip, Input, Tag, TextArea, cx } from "../ui";
import PlaceRow, { RowMenu, type RowMenuItem, type RowState } from "./PlaceRow";
import { ONE_AT_A_TIME, pastedWhen, pastesOf, pasteTitle, type Paste } from "../../lib/pastes";
import { PROXIES_ASK, type ProxiesAsk } from "../../lib/proxiesAsk";
import { numberedNames } from "../../lib/review";
import { countFeature } from "../../lib/usage";

/* WHERE TO, read like a VPN's location list (the Proxies page since
   2026-09-30; ProxiesPage.tsx draws the tabs).

   Three kinds of place, one tab each:
     My proxies  the lines you bought, saved on this computer; paste one and
                 it is read and checked the moment it is complete.
     Groups      named groups of proxies the relay rotates through by a rule
                 you pick: connecting to one is one click.
     Free        an extra: public proxies by country, the fastest first, each
                 tested from here before it can be picked.

   The proxies and groups are the app's (src-tauri/src/places.rs): every row
   here is drawn from a view without passwords and names its place by id.

   Every row is a PlaceRow: a click connects, or moves you there while
   connected, the way proxy connectors and VPN apps work. The rest of a
   row's actions are behind its ⋯. */

export type DestTab = "proxies" | "groups" | "free";

/** What a group is, for the "i" on Groups. */
const GROUPS_INFO = (
  <>
    <p>A group is several proxies behind one click. HProxy moves through them by the rule you pick and skips one that stops answering.</p>
    <p>Copy your proxies and press Ctrl+V here, or drop the file on this page. The working ones of a check can be saved as a group from the Checker&rsquo;s Export menu.</p>
  </>
);

/** Text from outside Add's box: pasted anywhere on the page, or dropped on it (a file, or text
    dragged in). */
export type Incoming = { text: string; at: number; how: "paste" | "file" };

export type LineState = {
  parsed: ParsedLine | null;
  parseError: string | null;
  checking: boolean;
  verdict: Verdict | null;
};

export type DestinationsProps = {
  /** The Proxies page draws its own tabs above the list (ProxiesPage.tsx). */
  hideHeader?: boolean;
  tab: DestTab;
  setTab: (t: DestTab) => void;
  /** The place the switch connects to. */
  picked: Place | null;
  /** What the relay goes through now, whoever started it. */
  connected: Place | null;
  running: boolean;
  busy: boolean;
  /** The place a connect is under way to, while it is. */
  goingTo: Place | null;
  /** The member of a group being moved to, while that is under way. */
  goingToMember: number | null;
  /** Connected through a group: the member in use (its place in the group). */
  memberInUse: number | null;
  /** A member of a group, clicked: in use from now (or the group connected, starting there). */
  onConnectMember: (groupId: string, member: number) => void;
  /** The place the last connect failed on, and why. */
  problem: { place: Place; words: string } | null;
  now: number;
  /** A row's click: connect there, or move there while connected. */
  onConnect: (p: Place) => void;
  lineRef: RefObject<HTMLInputElement | null>;
  /** The places were read: an empty list is really empty. */
  ready: boolean;
  /** Something to say about the places: the last change did not go through,
      or the app read them from its copy. */
  note: string | null;

  proxies: ProxyView[];
  /** Saved proxies whose last check got no answer (never the one connected through): Remove
      takes them out, Restore brings them back for 5 seconds (2026-10-18). */
  dead: ProxyView[];
  onRemoveDead: () => void;
  /** Saved proxies taken out, Restore for 5 seconds after: a paste's Delete all, Select's Delete
      (2026-10-22). */
  onRemoveMany: (ids: string[]) => void;
  /** A name for each of several saved proxies at once (a paste's name, numbered; "" takes it away). */
  onNameMany: (ids: string[], names: string[]) => void;
  /** These saved proxies checked again, four at a time (a paste's Test them). */
  onTestSome: (ids: string[]) => void;
  /** A Remove waiting to happen: which ones, and since when. */
  removing: PendingRemove | null;
  onRestore: () => void;
  line: string;
  setLine: (v: string) => void;
  lineState: LineState;
  /** When the switch was last pressed with none of yours (0: not since you came here): the
      empty list says "Add your proxies first to start connecting!", popping in on each press,
      and the first that works connects once they are in. */
  asked: number;
  onAdd: () => void;
  /** A pasted list, accepted: every line kept becomes a saved proxy, with `details` (a last
      day, a note) on each of them and, with `name`, that name numbered on the new ones. */
  onAddMany: (lines: string[], details?: Details, name?: string) => void;
  /** Connect's paste field: save the line and connect through it at once. */
  onAddAndConnect: () => void;
  onRecheck: () => void;
  onForget: (p: ProxyView) => void;
  /** Name a saved proxy; an empty name takes the name away. */
  onRename: (p: ProxyView, name: string) => void;
  /** Name, last day and note of saved proxies; the words of why not, or null. */
  onDescribe: (ids: string[], details: Details) => Promise<string | null>;
  /** The same for a group (it keeps its name). */
  onDescribeGroup: (id: string, details: Details) => Promise<string | null>;
  /** Saved proxies being checked right now, by id. */
  checkingIds: ReadonlySet<string>;
  /** Check one saved proxy again. */
  onCheckOne: (p: ProxyView) => void;
  testing: { done: number; total: number } | null;
  onTestAll: () => void;

  groups: GroupView[];
  /** Save a group (and pick it); with `connect`, connect through it at once.
      Rejects with the words to show, and the editor stays open. */
  onSaveGroup: (g: GroupInput, connect?: boolean) => Promise<void>;
  onForgetGroup: (g: GroupView) => void;
  /** Every member of a group in the Checker. */
  onCheckGroup: (g: GroupView) => void;
  /** Lines in the Checker (the group editor's "Check them first"). */
  onCheckLines: (lines: string[]) => void;

  /** The Free tab's country ("" anywhere) and protocol: what its list shows.
      Choosing them picks nothing; a row does. */
  freeCountry: string;
  setFreeCountry: (code: string) => void;
  freeSocks5: boolean;
  setFreeSocks5: (v: boolean) => void;
  /** Text pasted or dropped anywhere on the page: a drop joins what is in Add's box (2026-10-22);
      a pasted list opens its test, one pasted proxy goes into the box. */
  incoming: Incoming | null;
  /** A file is held over the Proxies page (2026-10-22): My proxies opens Add, whose right half says
      where it goes. */
  dragging?: boolean;
};

export default function Destinations(p: DestinationsProps) {
  const tabs = [
    ["proxies", `My proxies${p.proxies.length ? ` ${p.proxies.length}` : ""}`],
    ["groups", `Groups${p.groups.length ? ` ${p.groups.length}` : ""}`],
    ["free", "Free"],
  ] as const;
  return (
    // On the Proxies page (its own parts above it) the list stands on the page itself: less boxy (2026-10-12).
    <div className={p.hideHeader ? "ux-flat flex flex-col gap-4" : "ux-panel flex flex-col gap-4 p-5 max-sm:p-4"}>
      {!p.hideHeader && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <BlockTitle name="Where to" />
          <ButtonGroup options={tabs} value={p.tab} onChange={p.setTab} />
        </div>
      )}
      {p.tab === "proxies" && <ProxiesPane {...p} />}
      {p.tab === "groups" && <GroupsPane {...p} />}
      {p.tab === "free" && <FreePane {...p} />}
    </div>
  );
}

/** A place's row state: connected through it, connecting to it, or neither. */
export function rowState(place: Place, p: Pick<DestinationsProps, "running" | "connected" | "goingTo">): RowState {
  if (p.running && samePlace(place, p.connected)) return "connected";
  if (samePlace(place, p.goingTo)) return "connecting";
  return "idle";
}

/** Why the last connect through this place failed, if it was this place. */
export function rowProblem(place: Place, p: Pick<DestinationsProps, "problem">): string | null {
  return p.problem && samePlace(p.problem.place, place) ? capitalized(p.problem.words) : null;
}

/** Until the places are read, and whatever there is to say about them. */
function PlacesNote({ p, what }: { p: DestinationsProps; what: string }) {
  if (!p.ready) return <p className="px-1 text-[13.5px] font-medium text-ink-mute">Reading your {what}…</p>;
  return p.note ? <p className="px-1 text-[13px] font-semibold text-warn">{capitalized(p.note)}</p> : null;
}

/* ── My proxies ─────────────────────────────────────────────────────────── */

/** The order My proxies was last shown in: a convenience of this computer. */
const SORT_KEY = "hproxy-saved-sort";
function loadSort(): SavedSort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return isSavedSort(v) ? v : "recent";
  } catch {
    return "recent";
  }
}
function keepSort(s: SavedSort) {
  try {
    localStorage.setItem(SORT_KEY, s);
  } catch {
    /* the order is a convenience; it is back to Recently used next time */
  }
}

/* Your own proxies (rebuilt 2026-09-30 on how proxy connectors build their
   lists): a bar on top (search, order, Test all, Select), then one row per
   proxy. A click connects; ⋯ holds Rename, Check again, Copy address and
   Remove. Add's box waits behind the page's Add (top right, with Paste what I
   copied, since 2026-10-22) once the list has something in it; while the list
   is empty it is the first thing on the page. A paste anywhere: one proxy goes
   into the box, a whole list straight to its test (PasteReview.tsx), where
   every line is read by the engine and accepted in one click. A file, dropped
   or chosen, joins what is in the box. */
function ProxiesPane(p: DestinationsProps) {
  const [pasted, setPasted] = useState<string[] | null>(null);
  // The saved proxy whose name, expiry and note are open, by id.
  const [describing, setDescribing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // What is typed or pasted into Add's box (2026-10-22), and why the last way in found nothing.
  const [boxText, setBoxText] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  /* The lines the box sent to the review: they leave the box only once they are kept, so Cancel
     gives back everything typed, a line with a typo to fix too ("don't just make the whole system
     break"). Null when the review came from a paste. */
  const sentFromBox = useRef<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [sort, setSortState] = useState<SavedSort>(loadSort);
  const setSort = (s: SavedSort) => {
    setSortState(s);
    keepSort(s);
  };
  /* Select (since 2026-10-22, for deleting many added proxies at once): tick rows, or a whole paste
     at its title, then Delete; Restore stays for 5 seconds. */
  const [selecting, setSelecting] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const tick = (ids: string[], on: boolean) =>
    setTicked((was) => {
      const next = new Set(was);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setTicked(new Set());
  };
  useEffect(() => {
    if (!selecting) return;
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) stopSelecting();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selecting]);
  // A paste folded away, by its key; the paste whose name, expiry and note are open.
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [describingPaste, setDescribingPaste] = useState<string | null>(null);
  const empty = p.ready && p.proxies.length === 0;
  const takePaste = (text: string): boolean => {
    const lines = [...new Set(listLines(text))];
    if (lines.length < 2) return false;
    sentFromBox.current = null;
    setPasted(lines);
    return true;
  };
  /** Text that came in (a file, or one pasted proxy) joins what is in the box, without the lines it
      holds already, to be looked at and added (since 2026-10-22). */
  const intoBox = (text: string) => {
    setBoxText((had) => mergeLines(had, text));
    setProblem(null);
    setTimeout(() => boxRef.current?.focus(), 30);
  };
  // Dropped anywhere on the page: into the box. Pasted: a list opens its test, one proxy goes into the box.
  useEffect(() => {
    if (!p.incoming) return;
    setAdding(true);
    if (p.incoming.how === "file" || !takePaste(p.incoming.text)) intoBox(p.incoming.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.incoming]);
  // A file held over the list opens Add, so its right half can show where the file goes.
  useEffect(() => {
    if (p.dragging) setAdding(true);
  }, [p.dragging]);
  // The page's top-right Add and Paste what I copied (ProxiesPage.tsx, lib/proxiesAsk.ts).
  const asks = useRef({ paste: () => {}, add: () => {} });
  useEffect(() => {
    const hear = (e: Event) => {
      const what = (e as CustomEvent<ProxiesAsk>).detail;
      if (what === "paste") asks.current.paste();
      else asks.current.add();
    };
    window.addEventListener(PROXIES_ASK, hear);
    return () => window.removeEventListener(PROXIES_ASK, hear);
  }, []);

  // Paste what I copied: a list opens the review, one proxy goes into the box; a clipboard the
  // window may not read leaves the box waiting, where Ctrl+V works.
  const pasteList = () =>
    void navigator.clipboard
      .readText()
      .then((t) => {
        if (!t.trim()) return setProblem("Nothing is copied yet: copy your proxies, then press Paste.");
        setProblem(null);
        if (!takePaste(t)) intoBox(t);
      })
      .catch(() => {
        setProblem("Press Ctrl+V in the box.");
        boxRef.current?.focus();
      });
  // A file of proxies, chosen: into the box with the rest, as a dropped one goes.
  const uploadList = () =>
    void importProxyFile()
      .then((t) => {
        if (t?.trim()) intoBox(t);
      })
      .catch(() => {});
  // Add: whatever is in the box, one proxy or many, tested before it is kept; the box keeps its
  // text until they are.
  const addFromBox = () => {
    const lines = [...new Set(listLines(boxText))];
    if (!lines.length) return;
    sentFromBox.current = lines;
    setPasted(lines);
  };
  const openAdd = () => {
    setAdding(true);
    setProblem(null);
    setTimeout(() => boxRef.current?.focus(), 30);
  };
  asks.current = {
    paste: () => {
      setAdding(true);
      pasteList();
    },
    add: openAdd,
  };

  if (pasted) {
    // Once they are kept, what the box sent leaves it, and Add closes, unless something was
    // dropped into its box meanwhile.
    const done = () => {
      const sent = sentFromBox.current;
      sentFromBox.current = null;
      const left = sent ? withoutLines(boxText, sent) : boxText;
      if (sent) setBoxText(left);
      setPasted(null);
      setAdding(!!left.trim());
    };
    return (
      <PasteReview
        lines={pasted}
        room={MAX_PROXIES - p.proxies.length}
        onCancel={() => {
          sentFromBox.current = null;
          setPasted(null);
        }}
        onAdd={(kept, details, name) => {
          p.onAddMany(kept, details, name);
          done();
        }}
      />
    );
  }

  const shown = matchSaved(sortSaved(p.proxies, sort), typed);
  const sortName = SAVED_SORTS.find(([s]) => s === sort)?.[1] ?? "Recently used";
  const some = p.proxies.length > 0;
  // Adding is a clean page of its own: the saved list steps aside meanwhile (since 2026-10-22; the
  // old rows beside the box only got in the way).
  const listShown = some && !adding;
  // Every paste its own group; with no paste among them, the list as it always was.
  const pastes = pastesOf(shown);
  const sectioned = pastes.some((x) => x.key !== ONE_AT_A_TIME);
  const tickedShown = shown.filter((s) => ticked.has(s.id));
  const allTicked = shown.length > 0 && tickedShown.length === shown.length;
  const deleteTicked = () => {
    p.onRemoveMany(tickedShown.map((s) => s.id));
    stopSelecting();
  };
  const rowOf = (s: ProxyView) => (
    <ProxyRow
      key={s.id}
      s={s}
      p={p}
      describing={describing === s.id}
      setDescribing={setDescribing}
      select={selecting ? { on: ticked.has(s.id), onToggle: () => tick([s.id], !ticked.has(s.id)) } : undefined}
    />
  );

  return (
    <>
      <PlacesNote p={p} what="proxies" />
      {listShown &&
        (selecting ? (
          <div className="ux-listbar is-selecting" role="toolbar" aria-label="Selected proxies">
            <span className="grow ux-selectcount">
              {tickedShown.length ? `${spacedN(tickedShown.length)} selected` : "Tick the ones to delete, or a whole paste at its name"}
            </span>
            <Button variant="text" onClick={() => tick(shown.map((s) => s.id), !allTicked)}>
              {allTicked ? "Untick all" : "Select all"}
            </Button>
            <Button variant="danger" disabled={!tickedShown.length} onClick={deleteTicked} title="Restore stays for 5 seconds after">
              <Icon.trash className="h-4 w-4" />
              {tickedShown.length ? `Delete ${spacedN(tickedShown.length)}` : "Delete"}
            </Button>
            <Button variant="text" onClick={stopSelecting} title="Done (Escape)">
              Cancel
            </Button>
          </div>
        ) : (
          <div className="ux-listbar">
            <span className="grow">
              <Input
                icon="search"
                value={typed}
                onChange={(v) => {
                  setTyped(v);
                  if (v.trim()) countFeature("search");
                }}
                placeholder="Search by name, address or place"
                label="Search your proxies"
              />
            </span>
            <Dropdown label={sortName} items={SAVED_SORTS.map(([s, name]) => ({ label: name, onClick: () => setSort(s) }))} />
            <Button variant="text" disabled={!!p.testing} onClick={p.onTestAll} title="Check every saved proxy again">
              <Icon.refresh className="h-4 w-4" />
              {p.testing ? `Testing ${p.testing.done} of ${p.testing.total}` : "Test all"}
            </Button>
            <Button variant="text" onClick={() => setSelecting(true)} title="Tick several and delete them at once">
              <Icon.check className="h-4 w-4" />
              Select
            </Button>
          </div>
        ))}

      {listShown && <DeadLine p={p} />}

      {/* Adding: the box to type or paste into, a file beside it (AddProxies.tsx), the whole page
          for it; the page's top right opens it and pastes (ProxiesPage.tsx). */}
      {(adding || empty) && (
        <AddProxies
          asked={empty ? p.asked : 0}
          problem={problem}
          text={boxText}
          setText={setBoxText}
          boxRef={boxRef}
          onUpload={uploadList}
          onAdd={addFromBox}
          onClose={empty ? undefined : () => setAdding(false)}
          dragging={!!p.dragging}
        />
      )}

      {!listShown ? null : shown.length === 0 ? (
        <p className="px-1 text-[13.5px] font-medium text-ink-mute">None of your proxies matches &ldquo;{typed.trim()}&rdquo;.</p>
      ) : !sectioned ? (
        <div className="ux-places" role="list" aria-label="Your proxies">
          {shown.map(rowOf)}
        </div>
      ) : (
        <div className="ux-pastes">
          {pastes.map((paste) => {
            const ids = paste.proxies.map((x) => x.id);
            // A search opens every paste: what it found is never folded away.
            const open = !folded.has(paste.key) || !!typed.trim();
            const toggleFold = () =>
              setFolded((was) => {
                const next = new Set(was);
                if (next.has(paste.key)) next.delete(paste.key);
                else next.add(paste.key);
                return next;
              });
            const all = ids.every((id) => ticked.has(id));
            return (
              <section key={paste.key} className="ux-paste" aria-label={pasteTitle(paste, p.now)}>
                <PasteHead
                  paste={paste}
                  p={p}
                  open={open}
                  onFold={toggleFold}
                  select={selecting ? { on: all, onToggle: () => tick(ids, !all) } : undefined}
                  onDescribe={() => setDescribingPaste(paste.key)}
                />
                {describingPaste === paste.key && (
                  <DetailsEditor
                    name={paste.name}
                    expires={sameOf(paste.proxies.map((x) => x.expires))}
                    note={sameOf(paste.proxies.map((x) => x.note))}
                    nameHint={`One name for all ${spacedN(ids.length)}, numbered, like "Shop account"`}
                    onSave={async (d) => {
                      const name = (d.name ?? "").trim();
                      if (name !== paste.name) p.onNameMany(ids, name ? numberedNames(name, ids.length) : ids.map(() => ""));
                      return p.onDescribe(ids, { expires: d.expires, note: d.note });
                    }}
                    onDone={() => setDescribingPaste(null)}
                  />
                )}
                {open && (
                  <div className="ux-places" role="list" aria-label={pasteTitle(paste, p.now)}>
                    {paste.proxies.map(rowOf)}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {listShown && <p className="px-1 text-[12.5px] font-medium text-ink-mute">Kept on {thisDevice()} only.</p>}
      <RestoreBar p={p} />
    </>
  );
}

/** The value every one of them has, or nothing when they differ. */
const sameOf = (values: (string | undefined)[]): string | undefined => (values.every((v) => v === values[0]) ? values[0] : undefined);

/** A paste's title (2026-10-22): its name, or when it came in, and how many; a click folds it away.
    ⋯ holds Name them (numbered), expiry and note; Test; Delete all with Restore. While selecting, a
    tick that takes all of it. */
function PasteHead({
  paste,
  p,
  open,
  onFold,
  select,
  onDescribe,
}: {
  paste: Paste;
  p: DestinationsProps;
  open: boolean;
  onFold: () => void;
  select?: { on: boolean; onToggle: () => void };
  onDescribe: () => void;
}) {
  const ids = paste.proxies.map((x) => x.id);
  const n = ids.length;
  const one = paste.key === ONE_AT_A_TIME;
  const title = pasteTitle(paste, p.now);
  const count = `${spacedN(n)} ${n === 1 ? "proxy" : "proxies"}`;
  const meta = !one && paste.name ? `${count} · pasted ${pastedWhen(paste.addedAt, p.now)}` : count;
  const menu: RowMenuItem[] = [
    ...(one ? [] : [{ label: "Name them, expiry and note", onClick: onDescribe }]),
    { label: n === 1 ? "Test it" : `Test all ${spacedN(n)}`, onClick: () => p.onTestSome(ids) },
    { label: n === 1 ? "Delete it" : `Delete all ${spacedN(n)}`, onClick: () => p.onRemoveMany(ids), danger: true },
  ];
  return (
    <div className="ux-pastehead">
      {select && (
        <button type="button" className={cx("tick", select.on && "is-on")} onClick={select.onToggle} aria-pressed={select.on} aria-label={`Select all of ${title}`}>
          <Icon.check />
        </button>
      )}
      <button type="button" className="fold" aria-expanded={open} onClick={onFold} title={open ? "Fold them away" : "Show them"}>
        <Icon.chevronRight className="chev" />
        <span className="title">{title}</span>
        <span className="meta num">{meta}</span>
      </button>
      {!select && <RowMenu items={menu} title={title} />}
    </div>
  );
}

/** The ones whose last check got no answer, and one press to take them out; Restore follows
    (2026-10-18). Hidden while Test all runs: the answers are still coming. */
function DeadLine({ p }: { p: DestinationsProps }) {
  const n = p.dead.length;
  if (!n || p.testing) return null;
  return (
    <div className="ux-deadline" role="status">
      <span>{n === 1 ? "1 doesn't answer right now" : `${n} don't answer right now`}</span>
      <button type="button" className="ux-deadline-remove" onClick={p.onRemoveDead}>
        {n === 1 ? "Remove it" : "Remove them"}
      </button>
    </div>
  );
}

/** After a Remove: how many went, and Restore, for 5 seconds, at the window's foot; a line runs
    out meanwhile (since 2026-10-18). */
function RestoreBar({ p }: { p: DestinationsProps }) {
  const r = p.removing;
  if (!r) return null;
  return (
    <div key={r.at} className="ux-restore" role="status">
      <span>{r.ids.length === 1 ? "1 proxy removed" : `${r.ids.length} proxies removed`}</span>
      <button type="button" className="ux-restore-btn" onClick={p.onRestore}>
        Restore
      </button>
      <i className="ux-restore-time" style={{ animationDuration: `${UNDO_MS}ms` }} aria-hidden="true" />
    </div>
  );
}

/** The paste field, on My proxies and on Connect while you have no places yet:
    a proxy is read as it is typed and checked for real a moment later, the
    answer under it; Add (or Enter) saves it and picks it. A pasted list goes to
    `onMany`, which returns true when it took it. */
export function LineField({
  p,
  inputRef,
  solid,
  placeholder,
  onMany,
  onEscape,
  after,
  connect = false,
}: {
  p: DestinationsProps;
  inputRef: RefObject<HTMLInputElement | null>;
  /** The page's one blue button (the field is the first thing to do there). */
  solid: boolean;
  placeholder: string;
  onMany: (text: string) => boolean;
  onEscape?: () => void;
  /** More buttons on the field's line. */
  after?: ReactNode;
  /** Connect's field: its button connects through the line (and keeps it in My proxies),
      where the Proxies page's only adds it. */
  connect?: boolean;
}) {
  const { parsed, parseError, checking, verdict } = p.lineState;
  const go = connect ? p.onAddAndConnect : p.onAdd;
  return (
    <>
      {/* On a phone the field takes the whole width, its buttons under it:
          beside them it was cut to "Paste a proxy, c". */}
      <div className="flex items-center gap-2 max-sm:flex-wrap">
        <span className="min-w-0 flex-1 max-sm:basis-full">
          <Input
            inputRef={inputRef}
            value={p.line}
            onChange={p.setLine}
            onKeyDown={(e) => {
              if (e.key === "Enter" && parsed) go();
              if (e.key === "Escape") onEscape?.();
            }}
            onPaste={(e) => {
              if (onMany(e.clipboardData.getData("text"))) e.preventDefault();
            }}
            placeholder={placeholder}
            label="Proxy line"
            mono
            invalid={!!parseError}
          />
        </span>
        <Button variant={solid ? "solid" : "soft"} disabled={!parsed} onClick={go} title={connect ? "Connect through it, and keep it in My proxies (Enter)" : "Save it (Enter)"}>
          {connect ? <Icon.connect className="h-4 w-4" /> : <Icon.plus className="h-4 w-4" />}
          {connect ? "Connect" : "Add"}
        </Button>
        {after}
      </div>
      <div className="flex min-h-[22px] flex-wrap items-center gap-2 px-1 text-[13px] font-medium text-ink-mute">
        {parseError ? (
          <span className="font-semibold text-danger">{parseError}</span>
        ) : checking ? (
          <Tag>Checking it now</Tag>
        ) : verdict ? (
          <>
            {verdict.cc && <Flag cc={verdict.cc} />}
            <Tag tone={verdict.tone}>{verdict.headline}</Tag>
            {verdict.details.slice(0, 3).map((d) => (
              <span key={d}>{d}</span>
            ))}
            <button type="button" className="ux-link" onClick={p.onRecheck}>
              Check again
            </button>
          </>
        ) : parsed ? (
          <span>
            {parsed.scheme ? `${parsed.scheme.toUpperCase()} · ` : ""}
            {parsed.host}, port {parsed.port}, {parsed.auth ? "with login" : "no login"}
          </span>
        ) : null}
      </div>
    </>
  );
}

/** One of your proxies: its flag and name, the address under a name, how it
    did when last checked, its note, how many days it has left, and ⋯. The
    login, its last day and how often it was used are in the row's tooltip. */
function ProxyRow({
  s,
  p,
  describing,
  setDescribing,
  select,
}: {
  s: ProxyView;
  p: DestinationsProps;
  describing: boolean;
  setDescribing: (id: string | null) => void;
  /** Select is on: its tick, and a click ticks it. */
  select?: { on: boolean; onToggle: () => void };
}) {
  const place: Place = { kind: "proxy", id: s.id };
  const title = proxyTitle(s);
  const said = lastCheckWords(s.last);
  const status = !s.last ? (
    "Not checked yet"
  ) : said ? (
    <span className={`font-semibold ${said.tone === "danger" ? "text-danger" : "text-warn"}`}>{said.text}</span>
  ) : (
    s.last.place
  );
  // What the line is (a session in California); else, under a name, its address.
  const about = aboutWords(s.about);
  const what = about || (s.name ? s.address : "");
  const note = firstLine(s.note);
  const sub = (
    <>
      {what && <span className={about ? undefined : "num"}>{what}</span>}
      {what && status && " · "}
      {status}
      {note && ` · ${note}`}
    </>
  );
  const cc = s.last?.cc ?? s.about?.country?.toLowerCase();
  const tooltip = [
    s.address,
    s.user ? `login ${s.user}` : "no login",
    s.expires ? `last day ${dayWords(s.expires, todayHere())}` : "",
    s.uses ? `used ${s.uses === 1 ? "once" : `${s.uses} times`}, last ${formatAgo(p.now - s.lastUsedAt)}` : "not used yet",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <PlaceRow
      lead={cc ? <Flag cc={cc} /> : <Icon.globe />}
      name={title}
      mono={!s.name}
      sub={sub}
      ms={s.last?.ok ? (s.last.latencyMs ?? null) : null}
      checking={p.checkingIds.has(s.id)}
      tag={expiryTag(s.expires)}
      state={rowState(place, p)}
      running={p.running}
      busy={p.busy}
      problem={rowProblem(place, p)}
      tooltip={s.note ? `${tooltip}\n${s.note}` : tooltip}
      onConnect={() => p.onConnect(place)}
      select={select}
      below={
        describing ? (
          <DetailsEditor
            name={s.name ?? ""}
            expires={s.expires}
            note={s.note}
            nameHint={`A name for ${proxyTitle({ address: s.address, about: s.about })}, like "Netflix US"`}
            onSave={(d) => p.onDescribe([s.id], d)}
            onDone={() => setDescribing(null)}
          />
        ) : undefined
      }
      menu={[
        { label: "Name, expiry and note", onClick: () => setDescribing(s.id) },
        { label: "Check again", onClick: () => p.onCheckOne(s) },
        { label: "Copy address", onClick: () => void copyText(s.address) },
        { label: `Remove from ${thisDevice()}`, onClick: () => p.onForget(s), danger: true },
      ]}
    />
  );
}

/** A note's first line, for a row; the whole note is in the row's tooltip. */
const firstLine = (note: string | undefined) => (note ? note.split("\n")[0].trim() : "");

/** How many days a place has left, as a chip: plain while there is time,
    amber in its last three days, red once past. Nothing without a last day. */
function expiryTag(expires: string | undefined): ReactNode {
  const e = expiryOf(expires);
  if (!e || !expires) return undefined;
  return (
    <Tag tone={e.tone === "quiet" ? undefined : e.tone} title={`Last day: ${dayWords(expires, todayHere())}`}>
      {e.words}
    </Tag>
  );
}

/* What a person says about one of their places, under its row: a name, the
   day it expires and a note (a group keeps its name when the field is
   emptied). Save or Enter keeps them, Escape or Cancel leaves them as they
   were; a date that is not a day says so and the editor stays open. */
function DetailsEditor({
  name,
  expires,
  note,
  nameHint,
  keepsName = false,
  onSave,
  onDone,
}: {
  name: string;
  expires?: string;
  note?: string;
  nameHint: string;
  keepsName?: boolean;
  /** The words of why it was not kept, or null. */
  onSave: (d: Details) => Promise<string | null>;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(name);
  const [day, setDay] = useState(expires ?? "");
  const [text, setText] = useState(note ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const why = await onSave({ name: keepsName && !title.trim() ? undefined : title, expires: day, note: text });
    setSaving(false);
    if (why) setProblem(why);
    else onDone();
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onDone();
    }
  };
  const left = expiryOf(day || undefined);
  return (
    <div className="flex flex-col gap-3 px-2 pb-2 pt-1">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_190px]">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="px-1 text-[12.5px] font-semibold text-ink-mute">Name</span>
          <Input inputRef={first} value={title} onChange={setTitle} placeholder={nameHint} label="Name" onKeyDown={keys} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="px-1 text-[12.5px] font-semibold text-ink-mute">
            Expires on{left ? ` · ${left.words}` : ""}
          </span>
          <Input type="date" value={day} onChange={setDay} label="Expires on" onKeyDown={keys} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="px-1 text-[12.5px] font-semibold text-ink-mute">Note</span>
        <Input value={text} onChange={setText} placeholder="Where it is from, what it is for" label="Note" onKeyDown={keys} />
      </label>
      {problem && <p className="px-1 text-[13px] font-semibold text-danger">{problem}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="solid" disabled={saving} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" variant="text" onClick={onDone}>
          Cancel
        </Button>
        {day && (
          <Button size="sm" variant="text" onClick={() => setDay("")} title="It does not expire">
            No end date
          </Button>
        )}
        {text.length > MAX_NOTE && <span className="text-[12.5px] font-semibold text-warn">The first {MAX_NOTE} characters are kept.</span>}
      </div>
    </div>
  );
}

/* ── Groups ─────────────────────────────────────────────────────────────── */

/* Named groups of proxies the relay moves through by a rule: the same rows as
   My proxies (a click connects), ⋯ holds Edit, Check every proxy and Remove.
   Removing asks first, in the row itself. A row says what its group is from
   the app's summary (how many, sessions, where they all are), never from its
   lines, which stay with the app. */
function GroupsPane(p: DestinationsProps) {
  const [editing, setEditing] = useState<GroupView | "new" | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The group whose name, expiry and note are open, by id.
  const [describing, setDescribing] = useState<string | null>(null);
  // The group whose members are open, by id.
  const [opened, setOpened] = useState<string | null>(null);
  /* Text pasted or dropped anywhere on the page while the groups show: a new
     group starts with it, or the group being made gets it. */
  const [draft, setDraft] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => {
    if (!p.incoming) return;
    setEditing((e) => e ?? "new");
    setDraft(p.incoming);
  }, [p.incoming]);
  const day = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const pasteNew = () =>
    void navigator.clipboard
      .readText()
      .then((t) => {
        setEditing("new");
        if (t.trim()) setDraft({ text: t, at: Date.now() });
      })
      .catch(() => setEditing("new"));

  if (editing) {
    const close = () => {
      setEditing(null);
      setDraft(null);
    };
    return (
      <GroupEditor
        group={editing === "new" ? null : editing}
        draft={draft}
        defaultName={freeGroupName(p.groups, `Group ${day}`)}
        onCancel={close}
        onSave={async (g, connect) => {
          await p.onSaveGroup(g, connect);
          close();
        }}
        onCheck={p.onCheckLines}
      />
    );
  }

  return (
    <>
      <PlacesNote p={p} what="groups" />
      {/* With groups: how many, and New group. Without, the box below says it all (the
          bar alone showed a lone "i" over it, and two blue buttons for one thing). */}
      {p.groups.length > 0 && (
        <div className="ux-listbar">
          <p className="grow flex items-center gap-1.5 text-[13.5px] font-semibold text-ink-mute">
            {`${spacedN(p.groups.length)} ${p.groups.length === 1 ? "group" : "groups"}`}
            <InfoTip label="groups">{GROUPS_INFO}</InfoTip>
          </p>
          <Button variant="solid" onClick={() => setEditing("new")} title="Or press Ctrl+V anywhere here: a new group starts with what you copied">
            <Icon.plus className="h-4 w-4" />
            New group
          </Button>
        </div>
      )}

      {!p.ready ? null : p.groups.length === 0 ? (
        <div className="ux-addbox items-start">
          <p className="flex items-center gap-1.5 px-1 text-[15px] font-bold text-ink">
            No groups yet
            <InfoTip label="groups">{GROUPS_INFO}</InfoTip>
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="solid" onClick={pasteNew} title="Ctrl+V anywhere here works too, and so does dropping a file">
              <Icon.copy className="h-4 w-4" />
              Paste proxies
            </Button>
            <Button onClick={() => setEditing("new")} title="An empty group: name it, then add its proxies">
              <Icon.plus className="h-4 w-4" />
              New group
            </Button>
            {/* A phone has nothing to drop a file from. */}
            {!isMobile() && <span className="text-[13px] font-semibold text-ink-soft">or drop a file here</span>}
          </div>
        </div>
      ) : (
        <div className="ux-places" role="list" aria-label="Your groups">
          {p.groups.map((g) => {
            if (confirming === g.id) {
              return (
                <div key={g.id} role="listitem" className="ux-place is-confirm">
                  <div className="line">
                    <div className="main">
                      <span className="lead">
                        <Icon.trash />
                      </span>
                      <span className="text">
                        <span className="name">Remove &ldquo;{g.name}&rdquo;?</span>
                        <span className="sub">
                          {spacedN(g.size)} {g.size === 1 ? "proxy" : "proxies"}, removed from {thisDevice()} only
                        </span>
                      </span>
                    </div>
                    <Button size="sm" variant="text" onClick={() => setConfirming(null)}>
                      Keep it
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        setConfirming(null);
                        p.onForgetGroup(g);
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              );
            }
            const place: Place = { kind: "group", id: g.id };
            return (
              <PlaceRow
                key={g.id}
                lead={<Icon.layers />}
                name={g.name}
                sub={`${groupWords(g)}${g.uses > 0 ? ` · used ${formatAgo(p.now - g.lastUsedAt)}` : ""}${g.note ? ` · ${firstLine(g.note)}` : ""}`}
                tag={expiryTag(g.expires)}
                tooltip={g.note || undefined}
                below={
                  describing === g.id ? (
                    <DetailsEditor
                      name={g.name}
                      expires={g.expires}
                      note={g.note}
                      nameHint={g.name}
                      keepsName
                      onSave={(d) => p.onDescribeGroup(g.id, d)}
                      onDone={() => setDescribing(null)}
                    />
                  ) : undefined
                }
                state={rowState(place, p)}
                running={p.running}
                busy={p.busy}
                problem={rowProblem(place, p)}
                onConnect={() => p.onConnect(place)}
                expand={{
                  open: opened === g.id,
                  onToggle: () => setOpened((o) => (o === g.id ? null : g.id)),
                  label: opened === g.id ? "Hide its proxies" : `Pick one of its ${spacedN(g.size)} proxies`,
                }}
                menu={[
                  { label: "Edit", onClick: () => setEditing(g) },
                  { label: "Name, expiry and note", onClick: () => setDescribing(g.id) },
                  { label: "Check every proxy", onClick: () => p.onCheckGroup(g) },
                  { label: `Remove from ${thisDevice()}`, onClick: () => setConfirming(g.id), danger: true },
                ]}
              >
                <GroupMembers g={g} p={p} />
              </PlaceRow>
            );
          })}
        </div>
      )}
    </>
  );
}

/** How many members a group shows at a time. */
const MEMBERS_AT_ONCE = 100;

/* A group's members, opened from its row: a provider hands out residential
   sessions a hundred at a time, and this is where a person moves between
   them. They are read a hundred at a time, from the app, without passwords.
   A click makes one the proxy in use: within the connection when it runs
   through this group, else the group connects starting on it. A session
   shows as its session, the way My proxies shows one. */
function GroupMembers({ g, p }: { g: GroupView; p: DestinationsProps }) {
  const [members, setMembers] = useState<MemberView[]>([]);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const read = (from: number) => {
    setReading(true);
    void placesGroupMembers(g.id, from, MEMBERS_AT_ONCE)
      .then((more) => setMembers((had) => [...had.slice(0, from), ...more]))
      .catch((e: unknown) => setProblem(capitalized(String(e))))
      .finally(() => setReading(false));
  };
  // Read when opened (an edit closes the list, so it opens fresh after one),
  // and again should the group change size while open.
  useEffect(() => {
    setMembers([]);
    setProblem(null);
    read(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.id, g.size]);
  const place: Place = { kind: "group", id: g.id };
  const through = p.running && samePlace(p.connected, place);
  const going = samePlace(p.goingTo, place) || through;
  return (
    <div className="flex flex-col gap-2">
      {problem && <p className="px-1 text-[13px] font-semibold text-danger">{problem}</p>}
      <div className="ux-places" role="list" aria-label={`The proxies of ${g.name}`}>
        {members.map((m) => {
          const cc = m.about?.country?.toLowerCase();
          return (
            <PlaceRow
              key={m.index}
              lead={cc ? <Flag cc={cc} /> : <Icon.globe />}
              name={proxyTitle(m)}
              mono={!m.about?.session}
              sub={[`#${spacedN(m.index + 1)}`, aboutWords(m.about) || (m.user ? `login ${m.user}` : "no login")].join(" · ")}
              state={through && p.memberInUse === m.index ? "connected" : going && p.goingToMember === m.index ? "connecting" : "idle"}
              running={p.running}
              busy={p.busy}
              onConnect={() => p.onConnectMember(g.id, m.index)}
            />
          );
        })}
      </div>
      {members.length < g.size && (
        <button type="button" className="ux-link self-start" disabled={reading} onClick={() => read(members.length)}>
          {reading ? "Reading…" : `Show ${spacedN(Math.min(MEMBERS_AT_ONCE, g.size - members.length))} more of ${spacedN(g.size)}`}
        </button>
      )}
    </div>
  );
}

function GroupEditor({
  group,
  draft,
  defaultName,
  onCancel,
  onSave,
  onCheck,
}: {
  /** The group being edited; null for a new one. */
  group: GroupView | null;
  /** Text pasted or dropped on the page: added to the group's lines. */
  draft: { text: string; at: number } | null;
  /** The name a group saved without one gets. */
  defaultName: string;
  onCancel: () => void;
  /** Rejects with the words to show; the editor stays open then. */
  onSave: (g: GroupInput, connect: boolean) => Promise<void>;
  onCheck: (lines: string[]) => void;
}) {
  // A phone's Back leaves the editor, as Cancel does.
  useBack(true, onCancel);
  const [name, setName] = useState(group?.name ?? "");
  const [text, setText] = useState("");
  /* A group's lines come from the app when its editor opens: the window
     keeps none, and this is the person asking to see them. Anything pasted
     meanwhile goes after them. Until they are in, nothing can be saved, so a
     group is never saved without the lines it had. */
  const groupId = group?.id;
  const [loaded, setLoaded] = useState(!groupId);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!groupId) return;
    let live = true;
    void placesGroupLines(groupId)
      .then((kept) => {
        if (!live) return;
        const had = kept.join("\n");
        setText((typed) => (typed.trim() ? `${had}\n${typed}` : had));
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (live) setProblem(`Its proxies could not be read: ${String(e)}`);
      });
    return () => {
      live = false;
    };
  }, [groupId]);
  // Each paste is added once, even when React runs this effect twice.
  const takenAt = useRef<number | null>(null);
  useEffect(() => {
    if (!draft || takenAt.current === draft.at) return;
    takenAt.current = draft.at;
    const more = draft.text.trim();
    if (more) setText((prev) => (prev.trim() ? `${prev.replace(/\s*$/, "")}\n${more}` : more));
  }, [draft]);
  const [rule, setRule] = useState<Rule>(group?.rule ?? DEFAULT_ROTATION);
  const [everyN, setEveryN] = useState(String(group?.n ?? 10));
  const [saving, setSaving] = useState(false);
  const lines = listLines(text);
  const tooMany = lines.length > MAX_GROUP_LINES;
  // Read by the engine's parser up to a size where that stays instant; past it
  // the app reads them when saving and leaves out what it cannot read.
  const validate = lines.length <= 5000;
  const { read, done } = useReadable(lines, validate);
  const badAt = validate ? lines.flatMap((l, i) => (typeof read.get(l) === "string" ? [i + 1] : [])) : [];
  const good = validate && done ? lines.filter((l) => read.get(l) === true) : lines;
  const canSave = loaded && !saving && good.length > 0 && !(validate && !done);

  const build = (): GroupInput => ({
    id: groupId,
    name: name.trim() || (group?.name ?? defaultName),
    lines: good,
    rule,
    n: takesN(rule) ? Math.max(1, parseInt(everyN, 10) || 10) : undefined,
  });
  const save = async (connect: boolean) => {
    setSaving(true);
    setProblem(null);
    try {
      await onSave(build(), connect);
    } catch (e) {
      setProblem(capitalized(String(e)));
    } finally {
      setSaving(false);
    }
  };
  const add = (more: string) => setText((prev) => (prev.trim() ? `${prev.replace(/\s*$/, "")}\n${more}` : more));
  const pasteClipboard = () =>
    void navigator.clipboard
      .readText()
      .then((t) => t.trim() && add(t))
      .catch(() => {});
  const loadFile = () => void importProxyFile().then((t) => t && add(t));
  const empty = loaded && !text.trim();

  return (
    <div className="flex flex-col gap-4">
      <BlockTitle
        name={group ? `Edit "${group.name}"` : "New group"}
        value={
          !loaded
            ? "reading its proxies"
            : empty
              ? undefined
              : !validate || done
                ? `${spacedN(good.length)} ${good.length === 1 ? "proxy" : "proxies"}${badAt.length ? ` · ${spacedN(badAt.length)} unreadable` : ""}`
                : `reading ${spacedN(lines.length)} lines`
        }
      />
      {/* Empty, the box is where the proxies come in: the two ways as buttons,
          and the words for the rest. Typing works too: a click on the box
          goes to it. */}
      <div className="relative min-h-[200px]">
        <TextArea value={text} onChange={setText} placeholder={empty ? "" : "One proxy per line"} label="Proxies in the group" />
        {empty && (
          <div className="ux-listpaste">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="solid" onClick={pasteClipboard}>
                <Icon.copy className="h-4 w-4" />
                Paste from clipboard
              </Button>
              <Button onClick={loadFile}>
                <Icon.file className="h-4 w-4" />
                Load a file
              </Button>
            </div>
            <p>One proxy per line, any format</p>
          </div>
        )}
      </div>
      {!empty && (
        <Input value={name} onChange={setName} placeholder={`Name it, or it is "${group?.name ?? defaultName}"`} label="Group name" />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!empty && (
          <>
            <Button size="sm" onClick={pasteClipboard}>
              <Icon.copy className="h-4 w-4" />
              Paste more
            </Button>
            <Button size="sm" onClick={loadFile}>
              <Icon.file className="h-4 w-4" />
              Load a file
            </Button>
          </>
        )}
        {badAt.length > 0 && (
          <span className="text-[13px] font-semibold text-warn">
            {badAt.length === 1 ? `Line ${badAt[0]} is not a proxy` : `Lines ${badAt.slice(0, 4).join(", ")}${badAt.length > 4 ? " …" : ""} are not proxies`}: left out when you save.
          </span>
        )}
        {tooMany && (
          <span className="text-[13px] font-semibold text-warn">
            Only the first {spacedN(MAX_GROUP_LINES)} are kept on {thisDevice()}.
          </span>
        )}
      </div>
      {/* How to move through it: asked once there is something to move
          through, with the usual answer already picked. */}
      {!empty && (
        <div className="flex flex-col gap-2">
          <BlockTitle
            name="Switch proxies"
            info={
              <>
                <dl>
                  {ROTATION_RULES.map(([r, ruleName]) => (
                    <div key={r} className="contents">
                      <dt>{ruleName}</dt>
                      <dd>{ROTATION_HINT[r]}</dd>
                    </div>
                  ))}
                </dl>
                <p>A proxy that stops answering is skipped for a while.</p>
              </>
            }
          />
          <div className="flex flex-wrap items-center gap-3">
            <ButtonGroup size="sm" options={ROTATION_RULES} value={rule} onChange={setRule} />
            {rule === "every_n" && <Input value={everyN} onChange={setEveryN} type="number" min={1} max={100000} width="short" mono label="Connections per proxy" />}
            {rule === "every_minutes" && <Input value={everyN} onChange={setEveryN} type="number" min={1} max={10080} width="short" mono label="Minutes per proxy" />}
          </div>
        </div>
      )}
      {problem && <p className="px-1 text-[13px] font-semibold text-danger">{problem}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="solid" disabled={!canSave} onClick={() => void save(true)} title="Save the group and connect through it now">
          <Icon.connect className="h-4 w-4" />
          Save and connect
        </Button>
        <Button disabled={!canSave} onClick={() => void save(false)}>
          {group ? "Save changes" : "Save"}
        </Button>
        <Button variant="text" onClick={onCancel}>
          Cancel
        </Button>
        <span className="ml-auto">
          <Button variant="text" size="sm" disabled={good.length === 0} onClick={() => onCheck(good)} title="Check every proxy in the Checker first">
            <Icon.listCheck className="h-4 w-4" />
            Check them first
          </Button>
        </span>
      </div>
    </div>
  );
}

/* ── Free ───────────────────────────────────────────────────────────────── */

/** What the Free list asks the app for; lib/freeList.ts runs the tests. */
const FREE_DEPS = { list: freeList, test: freeTest };

/** The tested list of a country and protocol: started the first time it is
    shown, kept for a few minutes, redrawn as each test answers. */
function useFreeRun(country: string, socks5: boolean): FreeRun | undefined {
  const run = useSyncExternalStore(onFreeRuns, () => freeRun(country, socks5));
  useEffect(() => {
    ensureFreeRun(country, socks5, FREE_DEPS);
  }, [country, socks5]);
  return run;
}

/** The pool's countries: asked for the first time the Free tab is shown, then
    kept for ten minutes (lib/freeList.ts). */
function useFreeCountries(): CountriesState {
  const s = useSyncExternalStore(onFreeCountries, freeCountriesState);
  useEffect(() => {
    ensureFreeCountries(freeCountries);
  }, []);
  return s;
}

/* The free proxies as a list of countries (rebuilt 2026-09-30, the way VPN
   apps list their locations: the fastest country first, then every
   country by name and flag). A click connects to that country: the relay tests
   the pool there, takes the first proxy that works from here and swaps it when
   it stops. ▸ opens the country's own tested proxies for someone who wants to
   pick one; nothing is tested until then. Every country the pool has proxies in
   is here (free_countries: 119 on 2026-09-30), the most proxies first, and the
   search finds one by name or code. Free proxies are the extra; your own
   proxies are what this app is for. */
function FreePane(p: DestinationsProps) {
  const pool = useFreeCountries();
  const [typed, setTyped] = useState("");
  const choices = useMemo(() => countryChoices(pool.list, ""), [pool.list]);
  const shown = useMemo(() => matchCountries(choices, typed), [choices, typed]);
  // The country whose tested proxies are open; "" is any country.
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (code: string) => {
    setOpen((o) => (o === code ? null : code));
    p.setFreeCountry(code);
  };

  return (
    <>
      <FreeWarning />
      <div className="ux-listbar">
        <span className="grow">
          <Input icon="search" value={typed} onChange={setTyped} placeholder="Search a country" label="Search a country" />
        </span>
        <ButtonGroup
          size="sm"
          options={
            [
              ["http", "HTTP"],
              ["socks5", "SOCKS5"],
            ] as const
          }
          value={p.freeSocks5 ? "socks5" : "http"}
          onChange={(v) => p.setFreeSocks5(v === "socks5")}
        />
      </div>

      {shown.length === 0 ? (
        <p className="px-1 text-[13.5px] font-medium text-ink-mute">No country in the pool matches &ldquo;{typed.trim()}&rdquo;.</p>
      ) : (
        <div className="ux-places" role="list" aria-label="Free proxies by country">
          {shown.map((c) => (
            <CountryRow key={c.code || "any"} c={c} p={p} open={open === c.code} onToggle={() => toggle(c.code)} />
          ))}
        </div>
      )}
      {!pool.list && pool.error && (
        <p className="px-1 text-[12.5px] font-medium text-ink-mute">
          The countries did not load ({pool.error}): these are the usual few.
        </p>
      )}
    </>
  );
}

/** One country of the free pool, or "Fastest free proxy" for any country. A
    free connection counts as this country's whichever of its proxies is in use. */
function CountryRow({ c, p, open, onToggle }: { c: CountryChoice; p: DestinationsProps; open: boolean; onToggle: () => void }) {
  const any = !c.code;
  const place: Place = { kind: "free", country: c.code, socks5: p.freeSocks5 };
  const here = (x: Place | null | undefined) => x?.kind === "free" && x.country === c.code;
  const state: RowState = p.running && here(p.connected) ? "connected" : here(p.goingTo) ? "connecting" : "idle";
  const failedHere = p.problem?.place;
  const problem = p.problem && failedHere?.kind === "free" && here(failedHere) && !failedHere.exit ? capitalized(p.problem.words) : null;
  const through = state === "connected" && p.connected?.kind === "free" ? p.connected.exit : undefined;
  return (
    <PlaceRow
      lead={any ? <Icon.bolt /> : <Flag cc={c.code} />}
      name={any ? "Fastest free proxy" : c.name}
      sub={
        any
          ? "Any country, the quickest from here"
          : through
            ? `Through ${through}`
            : undefined
      }
      aside={c.count != null ? `${countWords(c.count)} free` : undefined}
      state={state}
      running={p.running}
      busy={p.busy}
      problem={problem}
      onConnect={() => p.onConnect(place)}
      expand={{
        open,
        onToggle,
        label: open ? "Hide these proxies" : any ? "Pick a free proxy yourself" : `Pick a free proxy in ${c.name} yourself`,
      }}
    >
      <FreeCountryProxies country={c.code} p={p} />
    </PlaceRow>
  );
}

/* A country's own free proxies, opened from its row: every one tested from
   here first, only the ones that pass listed (the fastest first once the tests
   are done), each one click from connecting; the ones that failed wait behind
   a link with the reason each failed. */
function FreeCountryProxies({ country, p }: { country: string; p: DestinationsProps }) {
  const socks5 = p.freeSocks5;
  const run = useFreeRun(country, socks5);
  const [showFailed, setShowFailed] = useState(false);
  const rows = run?.rows ?? [];
  const working = workingRows(rows);
  const failed = failedRows(rows);
  const testing = !run || run.loading || testsLeft(rows) > 0;
  const again = () => {
    setShowFailed(false);
    ensureFreeRun(country, socks5, FREE_DEPS, true);
  };
  const ownProxy = () => p.setTab("proxies");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-[30px] flex-wrap items-center justify-between gap-2">
        <span role="status" className="text-[13px] font-semibold text-ink-mute">
          {runWords(run, country, socks5)}
        </span>
        {!testing && rows.length > 0 && (
          <Button variant="text" size="sm" onClick={again} title="Ask the pool for a new batch and test it from here">
            <Icon.refresh className="h-4 w-4" />
            Test a fresh batch
          </Button>
        )}
      </div>

      {run?.error ? (
        <FreeTrouble words={capitalized(run.error)} again="Try again" onAgain={again} onOwn={ownProxy} />
      ) : working.length > 0 ? (
        <div className="ux-places" role="list" aria-label="Free proxies that work from here">
          {working.map((r) => (
            <FreeProxyRow key={r.addr} r={r} country={country} p={p} />
          ))}
        </div>
      ) : testing ? null : (
        <FreeTrouble
          words={
            rows.length === 0
              ? `No free proxies here right now. Try again, another country or ${socks5 ? "HTTP" : "SOCKS5"}.`
              : `None of them works from here right now. Try a fresh batch, another country or ${socks5 ? "HTTP" : "SOCKS5"}.`
          }
          again={rows.length === 0 ? "Try again" : "Test a fresh batch"}
          onAgain={again}
          onOwn={ownProxy}
        />
      )}

      {failed.length > 0 && (
        <div className="flex flex-col gap-2">
          <button type="button" className="ux-link self-start" aria-expanded={showFailed} onClick={() => setShowFailed((v) => !v)}>
            {showFailed ? "Hide" : "Show"} the {failed.length} that did not work, and why
          </button>
          {showFailed && (
            <div className="ux-places" role="list" aria-label="Free proxies that did not work from here">
              {failed.map((r) => (
                <PlaceRow
                  key={r.addr}
                  tone="bad"
                  lead={<Icon.cross />}
                  name={r.addr}
                  mono
                  sub={[capitalized(r.why ?? "did not work"), rowWhere(r)].filter(Boolean).join(" · ")}
                  running={p.running}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Where the Free tab's proxies come from on the website: the same list. */
const FREE_LIST_PAGE = "https://hproxy.com/free-proxy-list";

/* What free proxies are, before anything else on the Free tab: a warning that
   they are public proxies gathered from across the internet and not fully
   reliable, in one line since 2026-09-30, the rest behind "Why". It names no
   source: those stay private (only "from across the internet"). A solid well with a hairline, the mark in the warn colour:
   nothing see-through. */
function FreeWarning() {
  return (
    <div role="note" className="ux-freenote">
      <p className="line">
        <Icon.warning className="mark" />
        <span>
          <b>Free proxies are unreliable.</b> Never log in or pay through one.
        </span>
        <InfoTip label="free proxies">
          <p>
            Public proxies from across the internet, run by strangers, not by us. Many stop within minutes, and some can read what you send.
          </p>
          <p>Each one is tested from {thisDevice()} before it is listed. For anything that matters, connect a proxy of your own.</p>
          <p>
            <button type="button" className="ux-link" onClick={() => void openExternal(FREE_LIST_PAGE)}>
              The whole list on hproxy.com <Icon.arrowRight className="h-3.5 w-3.5" />
            </button>
          </p>
        </InfoTip>
      </p>
    </div>
  );
}

/** One free proxy that passed the test from here: its flag, its address, where
    it is and on whose network, how fast it answered. A click connects. */
function FreeProxyRow({ r, country, p }: { r: FreeRow; country: string; p: DestinationsProps }) {
  const place: Place = { kind: "free", country, socks5: p.freeSocks5, exit: r.addr, exitCountry: r.exit.country || undefined };
  return (
    <PlaceRow
      lead={r.exit.country ? <Flag cc={r.exit.country} /> : <Icon.globe />}
      name={r.addr}
      mono
      sub={rowPlace(r) || undefined}
      ms={r.ms ?? null}
      state={rowState(place, p)}
      running={p.running}
      busy={p.busy}
      problem={rowProblem(place, p)}
      onConnect={() => p.onConnect(place)}
    />
  );
}

/** When the Free list has nothing to connect to: why, and the two ways on. */
function FreeTrouble({ words, again, onAgain, onOwn }: { words: string; again: string; onAgain: () => void; onOwn: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[14px] bg-[var(--well)] p-5">
      <p className="max-w-[60ch] text-[13.5px] font-medium leading-relaxed text-ink-mute">{words}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="solid" onClick={onAgain}>
          <Icon.refresh className="h-4 w-4" />
          {again}
        </Button>
        <button type="button" className="ux-link" onClick={onOwn}>
          Connect a proxy of your own <Icon.arrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
