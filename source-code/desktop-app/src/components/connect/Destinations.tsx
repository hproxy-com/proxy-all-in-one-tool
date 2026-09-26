import { useEffect, useRef, useState, type RefObject } from "react";
import { FREE_COUNTRIES, ROTATION_HINT, ROTATION_RULES, formatAgo, lineParts, listLines, ruleWords, sameTarget, type RotationRule, type Target, type Verdict } from "../../lib/connect";
import { freeListName, makeList, MAX_LIST_LINES, MAX_SAVED, type SavedList, type SavedProxy } from "../../lib/saved";
import { importProxyFile, isMobile, parseLine, thisDevice, type ParsedLine } from "../../lib/tauri";
import { BlockTitle, Button, ButtonGroup, Flag, Icon, Input, Status, Tag, TextArea, cx } from "../ui";

/* WHERE TO: the right half of Connect, read like a VPN's location list
   (lists of your own can be saved).

   Three kinds of place, one tab each:
     My proxies  the lines you bought, saved on this computer; paste one and
                 it is read and checked the moment it is complete.
     My lists    named lists the relay rotates through by a rule you pick:
                 connecting to a list is one click, like a VPN's custom list.
     Free        the free pool by country, like a VPN's countries.

   A row picks the place (the switch on the left connects to it); its
   Connect button connects at once, and while connected it moves you there.
   The quiet actions (edit, check, remove) wait for the pointer. */

export type DestTab = "proxies" | "lists" | "free";

const spacedN = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

export type LineState = {
  parsed: ParsedLine | null;
  parseError: string | null;
  checking: boolean;
  verdict: Verdict | null;
};

export type DestinationsProps = {
  tab: DestTab;
  setTab: (t: DestTab) => void;
  target: Target | null;
  /** What the relay is connected to now, when this screen started it. */
  connected: Target | null;
  running: boolean;
  busy: boolean;
  now: number;
  onPick: (t: Target) => void;
  onConnect: (t: Target) => void;
  lineRef: RefObject<HTMLInputElement | null>;

  saved: SavedProxy[];
  line: string;
  setLine: (v: string) => void;
  lineState: LineState;
  onAdd: () => void;
  /** A pasted list, accepted: every readable line becomes a saved proxy. */
  onAddMany: (lines: string[]) => void;
  /** The same lines as one rotating list instead. */
  onListFromLines: (lines: string[]) => void;
  onRecheck: () => void;
  onForget: (p: SavedProxy) => void;
  testing: { done: number; total: number } | null;
  onTestAll: () => void;

  lists: SavedList[];
  listsSaveFailed: boolean;
  /** Save a list (and pick it); with `connect`, connect through it at once. */
  onSaveList: (l: SavedList, connect?: boolean) => void;
  onForgetList: (l: SavedList) => void;
  onCheckList: (l: SavedList) => void;

  freeSocks5: boolean;
  setFreeSocks5: (v: boolean) => void;
  /** Text pasted or dropped anywhere on Connect: one proxy fills the field,
      several open the review. */
  incoming: { text: string; at: number } | null;
};

export default function Destinations(p: DestinationsProps) {
  const tabs = [
    ["proxies", `My proxies${p.saved.length ? ` ${p.saved.length}` : ""}`],
    ["lists", `My lists${p.lists.length ? ` ${p.lists.length}` : ""}`],
    ["free", "Free"],
  ] as const;
  return (
    <div className="ux-panel flex flex-col gap-4 p-5 max-sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BlockTitle name="Where to" />
        <ButtonGroup options={tabs} value={p.tab} onChange={p.setTab} />
      </div>
      {p.tab === "proxies" && <ProxiesPane {...p} />}
      {p.tab === "lists" && <ListsPane {...p} />}
      {p.tab === "free" && <FreePane {...p} />}
    </div>
  );
}

/** The action at the end of a row: Connect, Switch here while connected
    elsewhere, or a quiet "Connected" when this is where the relay is. */
function RowAction({ t, p }: { t: Target; p: DestinationsProps }) {
  if (p.running && sameTarget(t, p.connected)) {
    return (
      <Status tone="ok" title="The relay is connected through this one">
        <Icon.check className="h-4 w-4" />
        Connected
      </Status>
    );
  }
  return (
    <Button size="sm" variant={sameTarget(t, p.target) && !p.running ? "solid" : "soft"} disabled={p.busy} onClick={() => p.onConnect(t)}>
      {p.running ? "Switch here" : "Connect"}
    </Button>
  );
}

/* ── My proxies ─────────────────────────────────────────────────────────── */

function ProxiesPane(p: DestinationsProps) {
  const { parsed, parseError, checking, verdict } = p.lineState;
  /* A paste of several lines is a list, not one proxy: it opens the review,
     where every line is read by the engine and accepted in one click: paste
     a list, get one profile per line, accept. */
  const [pasted, setPasted] = useState<string[] | null>(null);
  const takePaste = (text: string): boolean => {
    const lines = [...new Set(listLines(text))];
    if (lines.length < 2) return false;
    setPasted(lines);
    return true;
  };
  // Pasted or dropped anywhere on the page.
  useEffect(() => {
    if (!p.incoming) return;
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

  if (pasted) {
    return (
      <PasteReview
        lines={pasted}
        room={MAX_SAVED - p.saved.length}
        onCancel={() => setPasted(null)}
        onAddAll={(ok) => {
          p.onAddMany(ok);
          setPasted(null);
        }}
        onList={(ok) => {
          p.onListFromLines(ok);
          setPasted(null);
        }}
      />
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1">
            <Input
              inputRef={p.lineRef}
              value={p.line}
              onChange={p.setLine}
              onKeyDown={(e) => {
                if (e.key === "Enter" && parsed) p.onAdd();
              }}
              onPaste={(e) => {
                if (takePaste(e.clipboardData.getData("text"))) e.preventDefault();
              }}
              placeholder="Paste a proxy, or a whole list"
              label="Proxy line"
              mono
              invalid={!!parseError}
            />
          </span>
          <Button disabled={!parsed} onClick={p.onAdd} title="Save it here and pick it (Enter)">
            <Icon.plus className="h-4 w-4" />
            Add
          </Button>
          <Button variant="text" onClick={pasteList} title="Every line of the list in your clipboard becomes its own saved proxy">
            Paste a list
          </Button>
        </div>
        <div className="flex min-h-[24px] flex-wrap items-center gap-2 px-1 text-[13px] font-medium text-ink-mute">
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
          ) : (
            <span>Any shape your provider prints, checked for real the moment it is complete. Paste a whole list and each line becomes its own proxy.</span>
          )}
        </div>
      </div>

      {p.saved.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-[14px] bg-[var(--well)] p-5">
          <p className="text-[14.5px] font-bold text-ink">No saved proxies yet</p>
          <p className="max-w-[60ch] text-[13.5px] font-medium leading-relaxed text-ink-mute">
            Paste a proxy above and press Add, or just connect: every proxy you connect through is saved here for next time, one click away.
          </p>
          <button type="button" className="ux-link mt-1" onClick={() => p.setTab("free")}>
            Or try a free one <Icon.arrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="ux-dests">
          {p.saved.map((s) => {
            const t: Target = { kind: "fixed", line: s.line };
            const parts = lineParts(s.line);
            const on = sameTarget(t, p.target);
            return (
              <div key={s.id} className={cx("ux-dest", on && "is-on")}>
                <button type="button" className="pick" onClick={() => p.onPick(t)} onDoubleClick={() => p.onConnect(t)}>
                  <span className={cx("lead", s.last?.cc && "is-flag")}>
                    {s.last?.cc ? <Flag cc={s.last.cc} /> : <Icon.globe />}
                  </span>
                  <span className="text">
                    <span className="name num">{parts.address}</span>
                    <span className="sub">
                      {s.last ? (
                        s.last.ok ? (
                          <span className="ok">{s.last.latencyMs != null ? `Working · ${s.last.latencyMs} ms` : "Working"}</span>
                        ) : (
                          <span className="bad">Not answering</span>
                        )
                      ) : (
                        "Not checked yet"
                      )}
                      {[
                        s.last?.place,
                        parts.user ? `login ${parts.user}` : undefined,
                        s.uses ? `used ${s.uses === 1 ? "once" : `${s.uses} times`}, ${formatAgo(p.now - s.lastUsedAt)}` : "not used yet",
                      ]
                        .filter(Boolean)
                        .map((x) => ` · ${x}`)
                        .join("")}
                    </span>
                  </span>
                </button>
                <span className="acts">
                  <span className="quiet">
                    <button type="button" className="ux-iconbtn" title={`Remove from ${thisDevice()}`} aria-label={`Remove ${parts.address}`} onClick={() => p.onForget(s)}>
                      <Icon.trash className="h-4 w-4" />
                    </button>
                  </span>
                  <RowAction t={t} p={p} />
                </span>
              </div>
            );
          })}
        </div>
      )}

      {p.saved.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-[12.5px] font-medium text-ink-mute">
          {/* A phone has no double click; each row's own button connects. */}
          <span>
            Saved on {thisDevice()} only, passwords included.{isMobile() ? "" : " Double-click a row to connect."}
          </span>
          <Button variant="text" size="sm" disabled={!!p.testing} onClick={p.onTestAll} title="Check every saved proxy again">
            <Icon.refresh className="h-4 w-4" />
            {p.testing ? `Testing ${p.testing.done} of ${p.testing.total}` : "Test all"}
          </Button>
        </div>
      )}
    </>
  );
}

/* ── My lists ───────────────────────────────────────────────────────────── */

function ListsPane(p: DestinationsProps) {
  const [editing, setEditing] = useState<SavedList | "new" | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /* Text pasted or dropped anywhere on Connect while the lists show: a new
     list starts with it, or the list being made gets it. */
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
      <ListEditor
        list={editing === "new" ? null : editing}
        draft={draft}
        defaultName={freeListName(p.lists, `List ${day}`)}
        onCancel={close}
        onSave={(l, connect) => {
          p.onSaveList(l, connect);
          close();
        }}
        onCheck={(l) => p.onCheckList(l)}
      />
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[52ch] text-[13.5px] font-medium leading-relaxed text-ink-mute">
          A list is many proxies behind one switch. The relay moves through it by the rule you pick and rests a proxy that stops answering.
        </p>
        <Button onClick={() => setEditing("new")} title="Or press Ctrl+V anywhere here: a new list starts with what you copied">
          <Icon.plus className="h-4 w-4" />
          New list
        </Button>
      </div>

      {p.listsSaveFailed && (
        <p className="text-[13px] font-semibold text-warn">
          {thisDevice(true)}&rsquo;s storage is full: the newest change to your lists holds until the app closes. A shorter list fits.
        </p>
      )}

      {p.lists.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-[14px] bg-[var(--well)] p-5">
          <p className="text-[14.5px] font-bold text-ink">No lists yet</p>
          <p className="max-w-[60ch] text-[13.5px] font-medium leading-relaxed text-ink-mute">
            Copy your proxies from wherever they are and press Ctrl+V here, or drop the file on this page: they become a list. You can also
            save the working ones of a check from the Check tab&rsquo;s Export menu.
          </p>
          <Button variant="solid" onClick={pasteNew}>
            <Icon.copy className="h-4 w-4" />
            Paste a list
          </Button>
        </div>
      ) : (
        <div className="ux-dests">
          {p.lists.map((l) => {
            const t: Target = { kind: "list", id: l.id };
            const on = sameTarget(t, p.target);
            if (confirming === l.id) {
              return (
                <div key={l.id} className="ux-dest is-on">
                  <span className="pick">
                    <span className="text">
                      <span className="name">Remove &ldquo;{l.name}&rdquo;?</span>
                      <span className="sub">
                        Its {l.lines.length} proxies go from {thisDevice()}. The proxies themselves are not touched.
                      </span>
                    </span>
                  </span>
                  <span className="acts">
                    <Button size="sm" variant="text" onClick={() => setConfirming(null)}>
                      Keep it
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        setConfirming(null);
                        p.onForgetList(l);
                      }}
                    >
                      Remove
                    </Button>
                  </span>
                </div>
              );
            }
            return (
              <div key={l.id} className={cx("ux-dest", on && "is-on")}>
                <button type="button" className="pick" onClick={() => p.onPick(t)} onDoubleClick={() => p.onConnect(t)}>
                  <span className="lead">
                    <Icon.layers />
                  </span>
                  <span className="text">
                    <span className="name">{l.name}</span>
                    <span className="sub num">
                      {l.lines.length.toLocaleString("en-US").replace(/,/g, " ")} {l.lines.length === 1 ? "proxy" : "proxies"} · {ruleWords(l.rule, l.n)}
                      {l.uses > 0 && ` · used ${formatAgo(p.now - l.lastUsedAt)}`}
                    </span>
                  </span>
                </button>
                <span className="acts">
                  <span className="quiet flex items-center gap-0.5">
                    <button type="button" className="ux-iconbtn" title="Check every proxy on the Check tab" aria-label={`Check ${l.name}`} onClick={() => p.onCheckList(l)}>
                      <Icon.listCheck className="h-4 w-4" />
                    </button>
                    <button type="button" className="ux-iconbtn" title="Edit" aria-label={`Edit ${l.name}`} onClick={() => setEditing(l)}>
                      <Icon.edit className="h-4 w-4" />
                    </button>
                    <button type="button" className="ux-iconbtn" title="Remove" aria-label={`Remove ${l.name}`} onClick={() => setConfirming(l.id)}>
                      <Icon.trash className="h-4 w-4" />
                    </button>
                  </span>
                  <RowAction t={t} p={p} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function ListEditor({
  list,
  draft,
  defaultName,
  onCancel,
  onSave,
  onCheck,
}: {
  list: SavedList | null;
  /** Text pasted or dropped on the page: added to the list's lines. */
  draft: { text: string; at: number } | null;
  /** The name a list saved without one gets. */
  defaultName: string;
  onCancel: () => void;
  onSave: (l: SavedList, connect: boolean) => void;
  onCheck: (l: SavedList) => void;
}) {
  const [name, setName] = useState(list?.name ?? "");
  const [text, setText] = useState(list?.lines.join("\n") ?? "");
  // Each paste is added once, even when React runs this effect twice.
  const takenAt = useRef<number | null>(null);
  useEffect(() => {
    if (!draft || takenAt.current === draft.at) return;
    takenAt.current = draft.at;
    const more = draft.text.trim();
    if (more) setText((prev) => (prev.trim() ? `${prev.replace(/\s*$/, "")}\n${more}` : more));
  }, [draft]);
  const [rule, setRule] = useState<RotationRule>(list?.rule ?? "every_connection");
  const [everyN, setEveryN] = useState(String(list?.n ?? 10));
  const lines = listLines(text);
  const tooMany = lines.length > MAX_LIST_LINES;
  // Read by the engine's parser up to a size where that stays instant; past it
  // the relay reads them when connecting and says which it left out.
  const validate = lines.length <= 5000;
  const { read, done } = useReadable(lines, validate);
  const badAt = validate ? lines.flatMap((l, i) => (typeof read.get(l) === "string" ? [i + 1] : [])) : [];
  const good = validate && done ? lines.filter((l) => read.get(l) === true) : lines;

  const build = (): SavedList => {
    const fresh = makeList(name.trim() || (list?.name ?? defaultName), good, rule, parseInt(everyN, 10) || 10);
    return list ? { ...list, name: fresh.name, lines: fresh.lines, rule: fresh.rule, n: fresh.n } : fresh;
  };
  const add = (more: string) => setText((prev) => (prev.trim() ? `${prev.replace(/\s*$/, "")}\n${more}` : more));
  const pasteClipboard = () =>
    void navigator.clipboard
      .readText()
      .then((t) => t.trim() && add(t))
      .catch(() => {});
  const loadFile = () => void importProxyFile().then((t) => t && add(t));
  const empty = !text.trim();

  return (
    <div className="flex flex-col gap-4">
      <BlockTitle
        name={list ? `Edit "${list.name}"` : "New list"}
        value={
          empty
            ? undefined
            : !validate || done
              ? `${spacedN(good.length)} ${good.length === 1 ? "proxy" : "proxies"}${badAt.length ? ` · ${spacedN(badAt.length)} unreadable` : ""}`
              : `reading ${spacedN(lines.length)} lines`
        }
      />
      {/* Empty, the box is where the list comes in: the two ways as buttons,
          and the words for the rest. Typing works too: a click on the box
          goes to it. */}
      <div className="relative min-h-[200px]">
        <TextArea
          value={text}
          onChange={setText}
          placeholder={empty ? "" : "One proxy per line"}
          label="Proxies in the list"
        />
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
            <p>One proxy per line, any shape your provider prints. Ctrl+V anywhere on this page works, dropping the file too, or type them here.</p>
          </div>
        )}
      </div>
      {!empty && (
        <Input value={name} onChange={setName} placeholder={`Name it, or it is "${list?.name ?? defaultName}"`} label="List name" />
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
            Only the first {MAX_LIST_LINES.toLocaleString("en-US").replace(/,/g, " ")} are kept on {thisDevice()}.
          </span>
        )}
      </div>
      {/* How to move through it: asked once there is something to move
          through, with the usual answer already picked. */}
      {!empty && (
        <div className="flex flex-col gap-2">
          <BlockTitle name="Move through it" />
          <div className="flex flex-wrap items-center gap-3">
            <ButtonGroup size="sm" options={ROTATION_RULES} value={rule} onChange={setRule} />
            {rule === "every_n" && <Input value={everyN} onChange={setEveryN} type="number" min={1} max={100000} width="short" mono label="Connections per proxy" />}
          </div>
          <p className="text-[13px] font-medium leading-relaxed text-ink-mute">{ROTATION_HINT[rule]}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="solid" disabled={good.length === 0 || (validate && !done)} onClick={() => onSave(build(), true)} title="Save the list and connect through it now">
          <Icon.connect className="h-4 w-4" />
          Save and connect
        </Button>
        <Button disabled={good.length === 0 || (validate && !done)} onClick={() => onSave(build(), false)}>
          {list ? "Save changes" : "Save"}
        </Button>
        <Button variant="text" onClick={onCancel}>
          Cancel
        </Button>
        <span className="ml-auto">
          <Button variant="text" size="sm" disabled={good.length === 0} onClick={() => onCheck(build())} title="Check every proxy on the Check tab first">
            <Icon.listCheck className="h-4 w-4" />
            Check them first
          </Button>
        </span>
      </div>
    </div>
  );
}

/* ── Free ───────────────────────────────────────────────────────────────── */

function FreePane(p: DestinationsProps) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[52ch] text-[13.5px] font-medium leading-relaxed text-ink-mute">
          Public proxies run by strangers, each proven to relay before you get it and swapped when it dies. Fine for seeing a site from another country; never
          for anything with a login.
        </p>
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
      <div className="ux-dests">
        {FREE_COUNTRIES.map(([code, name]) => {
          const t: Target = { kind: "free", country: code, socks5: p.freeSocks5 };
          const on = sameTarget(t, p.target);
          return (
            <div key={code || "any"} className={cx("ux-dest", on && "is-on")}>
              <button type="button" className="pick" onClick={() => p.onPick(t)} onDoubleClick={() => p.onConnect(t)}>
                <span className={cx("lead", code && "is-flag")}>{code ? <Flag cc={code} /> : <Icon.globe />}</span>
                <span className="text">
                  <span className="name">{code ? name : "Fastest, anywhere"}</span>
                  <span className="sub">{code ? `A free ${p.freeSocks5 ? "SOCKS5" : "HTTP"} exit in ${name}` : "The quickest free exit in any country"}</span>
                </span>
              </button>
              <span className="acts">
                <RowAction t={t} p={p} />
              </span>
            </div>
          );
        })}
      </div>
    </>
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

/** Every line read by the engine's own parser, so what is accepted is exactly
    what will connect; the unreadable ones are shown with the engine's reason
    and left out. One click keeps them as proxies or as one list. */
function PasteReview({
  lines,
  room,
  onCancel,
  onAddAll,
  onList,
}: {
  lines: string[];
  room: number;
  onCancel: () => void;
  onAddAll: (ok: string[]) => void;
  onList: (ok: string[]) => void;
}) {
  const { read, done } = useReadable(lines);
  const ok = lines.filter((l) => read.get(l) === true);
  const bad = lines.filter((l) => typeof read.get(l) === "string");
  const shown = lines.slice(0, 150);

  return (
    <div className="flex flex-col gap-3">
      <BlockTitle
        name={`Found ${spacedN(lines.length)} proxies in what you pasted`}
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
          return (
            <div key={l} className="ux-dest !min-h-[44px]">
              <span className="pick !cursor-default">
                <span className={cx("lead", r === true ? "is-ok" : typeof r === "string" ? "is-bad" : "")}>
                  {r === true ? <Icon.check /> : typeof r === "string" ? <Icon.cross /> : <Icon.clock />}
                </span>
                <span className="text">
                  <span className="name num">{parts.address}</span>
                  <span className="sub">{typeof r === "string" ? <span className="bad">{r}</span> : parts.user ? `login ${parts.user}` : "no login"}</span>
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
        <Button disabled={!done || ok.length === 0} onClick={() => onList(ok)} title="One rotating list you connect to with one click">
          <Icon.layers className="h-4 w-4" />
          Make them one list
        </Button>
        <Button variant="text" onClick={onCancel}>
          Cancel
        </Button>
        {done && ok.length > room && (
          <span className="text-[13px] font-semibold text-warn">
            Room for {spacedN(Math.max(0, room))} more saved proxies; a list holds up to {spacedN(MAX_LIST_LINES)}.
          </span>
        )}
      </div>
    </div>
  );
}
