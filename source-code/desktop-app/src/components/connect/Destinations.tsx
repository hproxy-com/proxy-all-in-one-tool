import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import {
  DEFAULT_ROTATION,
  ROTATION_HINT,
  aboutWords,
  ROTATION_RULES,
  SAVED_SORTS,
  formatAgo,
  groupWords,
  isSavedSort,
  lineParts,
  listLines,
  matchSaved,
  proxyTitle,
  sortSaved,
  spacedN,
  takesN,
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
  freeGroupName,
  lastCheckWords,
  MAX_GROUP_LINES,
  MAX_NAME,
  MAX_PROXIES,
  samePlace,
  type GroupInput,
  type GroupView,
  type MemberView,
  type Place,
  type ProxyView,
  type Rule,
} from "../../lib/places";
import {
  copyText,
  describeLines,
  freeCountries,
  freeList,
  freeTest,
  importProxyFile,
  isMobile,
  openExternal,
  parseLine,
  placesGroupLines,
  placesGroupMembers,
  thisDevice,
  type ParsedLine,
  type Targeting,
} from "../../lib/tauri";
import { useBack } from "../../lib/back";
import { pasteOneHere } from "../../lib/proxyExamples";
import { BlockTitle, Button, ButtonGroup, Dropdown, Flag, Icon, InfoTip, Input, Tag, TextArea, cx } from "../ui";
import PlaceRow, { type RowState } from "./PlaceRow";

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
   connected, the way proxy connectors and VPN apps work (monorepo
   docs/research-2026-09-30-proxy-connector-apps/PLAN.md). The rest of a
   row's actions are behind its ⋯. */

export type DestTab = "proxies" | "groups" | "free";

/** What a group is, for the "i" on Groups. */
const GROUPS_INFO = (
  <>
    <p>A group is several proxies behind one click. HProxy moves through them by the rule you pick and skips one that stops answering.</p>
    <p>Copy your proxies and press Ctrl+V here, or drop the file on this page. The working ones of a check can be saved as a group from the Checker&rsquo;s Export menu.</p>
  </>
);

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
  line: string;
  setLine: (v: string) => void;
  lineState: LineState;
  onAdd: () => void;
  /** A pasted list, accepted: every readable line becomes a saved proxy. */
  onAddMany: (lines: string[]) => void;
  /** Connect's paste field: save the line and connect through it at once. */
  onAddAndConnect: () => void;
  /** The same lines as one group instead. */
  onGroupFromLines: (lines: string[]) => void;
  onRecheck: () => void;
  onForget: (p: ProxyView) => void;
  /** Name a saved proxy; an empty name takes the name away. */
  onRename: (p: ProxyView, name: string) => void;
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
  /** Text pasted or dropped anywhere on Connect: one proxy fills the field,
      several open the review. */
  incoming: { text: string; at: number } | null;
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
   lists): a bar on top (search, order, Test all, Add), then one row per proxy.
   A click connects; ⋯ holds Rename, Check again, Copy address and Remove. The
   paste field waits behind Add once the list has something in it; while the
   list is empty it is the first thing on the page. A paste anywhere opens it:
   one proxy fills the field, a whole list opens the review, where every line
   is read by the engine and accepted in one click. */
function ProxiesPane(p: DestinationsProps) {
  const [pasted, setPasted] = useState<string[] | null>(null);
  // The saved proxy being named, by id.
  const [naming, setNaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState("");
  const [sort, setSortState] = useState<SavedSort>(loadSort);
  const setSort = (s: SavedSort) => {
    setSortState(s);
    keepSort(s);
  };
  const empty = p.ready && p.proxies.length === 0;
  const takePaste = (text: string): boolean => {
    const lines = [...new Set(listLines(text))];
    if (lines.length < 2) return false;
    setPasted(lines);
    return true;
  };
  // Pasted or dropped anywhere on the page.
  useEffect(() => {
    if (!p.incoming) return;
    setAdding(true);
    if (!takePaste(p.incoming.text)) {
      p.setLine(p.incoming.text.trim());
      p.lineRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.incoming]);

  const pasteList = () =>
    void navigator.clipboard
      .readText()
      .then((t) => {
        if (!takePaste(t)) p.lineRef.current?.focus();
      })
      .catch(() => p.lineRef.current?.focus());
  const openAdd = () => {
    setAdding(true);
    setTimeout(() => p.lineRef.current?.focus(), 30);
  };

  if (pasted) {
    return (
      <PasteReview
        lines={pasted}
        room={MAX_PROXIES - p.proxies.length}
        onCancel={() => setPasted(null)}
        onAddAll={(ok) => {
          p.onAddMany(ok);
          setPasted(null);
          setAdding(false);
        }}
        onGroup={(ok) => {
          p.onGroupFromLines(ok);
          setPasted(null);
          setAdding(false);
        }}
      />
    );
  }

  const shown = matchSaved(sortSaved(p.proxies, sort), typed);
  const sortName = SAVED_SORTS.find(([s]) => s === sort)?.[1] ?? "Recently used";
  const some = p.proxies.length > 0;

  return (
    <>
      <PlacesNote p={p} what="proxies" />
      {some && (
        <div className="ux-listbar">
          <span className="grow">
            <Input icon="search" value={typed} onChange={setTyped} placeholder="Search by name, address or place" label="Search your proxies" />
          </span>
          <Dropdown label={sortName} items={SAVED_SORTS.map(([s, name]) => ({ label: name, onClick: () => setSort(s) }))} />
          <Button variant="text" disabled={!!p.testing} onClick={p.onTestAll} title="Check every saved proxy again">
            <Icon.refresh className="h-4 w-4" />
            {p.testing ? `Testing ${p.testing.done} of ${p.testing.total}` : "Test all"}
          </Button>
          <Button variant="solid" onClick={openAdd} title="Paste a proxy, or a whole list">
            <Icon.plus className="h-4 w-4" />
            Add
          </Button>
        </div>
      )}

      {(adding || empty) && (
        <div className="ux-addbox">
          {empty && <p className="px-1 pb-1 text-[15px] font-bold text-ink">Add your proxies</p>}
          <LineField
            p={p}
            inputRef={p.lineRef}
            solid={empty}
            placeholder={pasteOneHere(isMobile())}
            onMany={takePaste}
            onEscape={() => !empty && setAdding(false)}
            after={
              <>
                <Button variant="text" onClick={pasteList} title="Every line of the list in your clipboard becomes its own saved proxy">
                  Paste a list
                </Button>
                {!empty && (
                  <Button variant="text" onClick={() => setAdding(false)} title="Close (Escape)">
                    Close
                  </Button>
                )}
              </>
            }
          />
        </div>
      )}

      {empty ? (
        <button type="button" className="ux-link self-start px-1" onClick={() => p.setTab("free")}>
          Or use a free one <Icon.arrowRight className="h-3.5 w-3.5" />
        </button>
      ) : !some ? null : shown.length === 0 ? (
        <p className="px-1 text-[13.5px] font-medium text-ink-mute">None of your proxies matches &ldquo;{typed.trim()}&rdquo;.</p>
      ) : (
        <div className="ux-places" role="list" aria-label="Your proxies">
          {shown.map((s) => (
            <ProxyRow key={s.id} s={s} p={p} naming={naming === s.id} setNaming={setNaming} />
          ))}
        </div>
      )}

      {some && <p className="px-1 text-[12.5px] font-medium text-ink-mute">Kept on {thisDevice()} only.</p>}
    </>
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
    did when last checked, and ⋯. The login and how often it was used are in
    the row's tooltip. */
function ProxyRow({ s, p, naming, setNaming }: { s: ProxyView; p: DestinationsProps; naming: boolean; setNaming: (id: string | null) => void }) {
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
  const sub = (
    <>
      {what && <span className={about ? undefined : "num"}>{what}</span>}
      {what && status && " · "}
      {status}
    </>
  );
  const cc = s.last?.cc ?? s.about?.country?.toLowerCase();
  const tooltip = [
    s.address,
    s.user ? `login ${s.user}` : "no login",
    s.uses ? `used ${s.uses === 1 ? "once" : `${s.uses} times`}, last ${formatAgo(p.now - s.lastUsedAt)}` : "not used yet",
  ].join(" · ");
  return (
    <PlaceRow
      lead={cc ? <Flag cc={cc} /> : <Icon.globe />}
      name={title}
      mono={!s.name}
      sub={sub}
      ms={s.last?.ok ? (s.last.latencyMs ?? null) : null}
      checking={p.checkingIds.has(s.id)}
      state={rowState(place, p)}
      running={p.running}
      busy={p.busy}
      problem={rowProblem(place, p)}
      tooltip={tooltip}
      onConnect={() => p.onConnect(place)}
      editing={
        naming ? (
          <NameField
            initial={s.name ?? ""}
            address={proxyTitle({ address: s.address, about: s.about })}
            onDone={(name) => {
              p.onRename(s, name);
              setNaming(null);
            }}
            onCancel={() => setNaming(null)}
          />
        ) : undefined
      }
      menu={[
        { label: s.name ? "Rename" : "Give it a name", onClick: () => setNaming(s.id) },
        { label: "Check again", onClick: () => p.onCheckOne(s) },
        { label: "Copy address", onClick: () => void copyText(s.address) },
        { label: `Remove from ${thisDevice()}`, onClick: () => p.onForget(s), danger: true },
      ]}
    />
  );
}

/* Naming a saved proxy, in place of its title: Enter or clicking away keeps
   the name, Escape leaves it as it was, an empty name goes back to the
   address. */
function NameField({ initial, address, onDone, onCancel }: { initial: string; address: string; onDone: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  // Enter and Escape end it once: the blur that follows as the field goes
  // must not save again (after Escape it would save what Escape threw away).
  const ended = useRef(false);
  const end = (keep: boolean) => {
    if (ended.current) return;
    ended.current = true;
    if (keep) onDone(value);
    else onCancel();
  };
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  return (
    <input
      ref={field}
      className="ux-input ux-namefield"
      value={value}
      maxLength={MAX_NAME}
      placeholder={`A name for ${address}, like "Netflix US"`}
      aria-label={`Name for ${address}`}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          end(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          end(false);
        }
      }}
      onBlur={() => end(true)}
    />
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
                sub={`${groupWords(g)}${g.uses > 0 ? ` · used ${formatAgo(p.now - g.lastUsedAt)}` : ""}`}
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

/* ── A pasted list, before it is saved ──────────────────────────────────── */

/** Every line read by the engine's own parser, a dozen at a time: `true`, or
    the parser's reason it cannot be read. Answers are kept per line, so typing
    into a list only reads the lines that changed. */
function useReadable(lines: string[], enabled = true): { read: Map<string, true | string>; done: boolean } {
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
function useTargeting(lines: string[]): Map<string, Targeting | null> {
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

/** Every line read by the engine's own parser, so what is accepted is exactly
    what will connect; the unreadable ones are shown with the engine's reason
    and left out. One click keeps them as proxies or as one group. A batch of
    sessions shows each session, not the address they all share. */
function PasteReview({
  lines,
  room,
  onCancel,
  onAddAll,
  onGroup,
}: {
  lines: string[];
  /** How many more proxies can be saved. */
  room: number;
  onCancel: () => void;
  onAddAll: (ok: string[]) => void;
  onGroup: (ok: string[]) => void;
}) {
  // A phone's Back leaves the review, as Cancel does.
  useBack(true, onCancel);
  const { read, done } = useReadable(lines);
  const ok = lines.filter((l) => read.get(l) === true);
  const bad = lines.filter((l) => typeof read.get(l) === "string");
  const shown = lines.slice(0, 150);
  const targeting = useTargeting(shown);

  return (
    <div className="flex flex-col gap-3">
      <BlockTitle
        name={`${spacedN(lines.length)} proxies pasted`}
        value={
          done
            ? `${spacedN(ok.length)} ready${bad.length ? ` · ${spacedN(bad.length)} unreadable` : ""}`
            : `reading ${spacedN(lines.length)} lines`
        }
      />
      <div className="ux-dests max-h-[330px] overflow-y-auto rounded-[14px] bg-[var(--well)] p-1.5">
        {shown.map((l) => {
          const r = read.get(l);
          const parts = lineParts(l);
          const about = targeting.get(l) ?? null;
          return (
            <div key={l} className="ux-dest !min-h-[44px]">
              <span className="pick !cursor-default">
                <span className={cx("lead", r === true ? "is-ok" : typeof r === "string" ? "is-bad" : "")}>
                  {r === true ? <Icon.check /> : typeof r === "string" ? <Icon.cross /> : <Icon.clock />}
                </span>
                <span className="text">
                  <span className="name num">{proxyTitle({ address: parts.address, about })}</span>
                  <span className="sub">
                    {typeof r === "string" ? (
                      <span className="bad">{r}</span>
                    ) : (
                      aboutWords(about) || (parts.user ? `login ${parts.user}` : "no login")
                    )}
                  </span>
                </span>
              </span>
            </div>
          );
        })}
        {lines.length > shown.length && <p className="px-3 py-2 text-[13px] font-medium text-ink-mute">and {spacedN(lines.length - shown.length)} more</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="solid" disabled={!done || ok.length === 0 || ok.length > room} onClick={() => onAddAll(ok)} title="Each line becomes its own saved proxy">
          <Icon.plus className="h-4 w-4" />
          Add {done ? spacedN(ok.length) : "them"} as proxies
        </Button>
        <Button disabled={!done || ok.length === 0} onClick={() => onGroup(ok)} title="One group you connect to in one click">
          <Icon.layers className="h-4 w-4" />
          Make them one group
        </Button>
        <Button variant="text" onClick={onCancel}>
          Cancel
        </Button>
        {done && ok.length > room && (
          <span className="text-[13px] font-semibold text-warn">
            Room for {spacedN(Math.max(0, room))} more saved proxies; a group holds up to {spacedN(MAX_GROUP_LINES)}.
          </span>
        )}
      </div>
    </div>
  );
}
