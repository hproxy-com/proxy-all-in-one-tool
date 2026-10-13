/* BROWSER PREVIEW ONLY. A pretend library, so the places can be looked at (and
   screenshotted) without the desktop app: the same commands as
   src-tauri/src/places.rs, kept in memory for the page's life. Loaded only
   when the window is not Tauri (lib/tauri.ts). It reads no targeting out of
   a line (the Rust reader does that in the app), and never pretends to keep
   anything on disk. */

import type { CheckResult } from "./checker";
import { lineParts, maskLine } from "./connect";
import type { GroupInput, LibraryView, MemberView, Place, PlacesStart, ProxyView, Rule, Verdict } from "./places";
import type { WindowStorage } from "./windowStorage";

type Kept = { id: string; line: string; name?: string; addedAt: number; lastUsedAt: number; uses: number; last?: Verdict };
type KeptGroup = { id: string; name: string; lines: string[]; rule: Rule; n?: number; addedAt: number; lastUsedAt: number; uses: number };

const lib = { proxies: [] as Kept[], groups: [] as KeptGroup[], picked: null as Place | null, moved: false };
let groupSeq = 0;
/** What the paste field's checks found, kept a while like the app keeps them
    (src-tauri/src/places.rs, `checked`), so a line saved right after shows it. */
const checked = new Map<string, Verdict>();

function verdictOf(r: CheckResult, at: number): Verdict {
  return {
    ok: r.alive,
    latencyMs: r.latency_ms ?? undefined,
    cc: r.country_code?.toLowerCase(),
    place: [r.city, r.country].filter(Boolean).join(", ") || undefined,
    exitIp: r.exit_ip ?? undefined,
    anonymity: r.anonymity ?? undefined,
    at,
  };
}

export function demoChecked(line: string, r: CheckResult): void {
  checked.set(line.trim(), verdictOf(r, Date.now()));
}

/** The same id the library gives a line (FNV-1a over UTF-16, base 36). */
function idOf(line: string): string {
  let h = 2166136261;
  const t = line.trim();
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const readable = (line: string) => /^(?:\w+:\/\/)?(?:[^@\s]+@)?[^:\s@]+:\d{1,5}(?::[^:\s]+:.+)?$/.test(line.trim());
const cleanName = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, 60).trim();

function view(): LibraryView {
  return {
    proxies: lib.proxies.map((p): ProxyView => {
      // As the library shows a line it cannot read: a row that can be removed.
      const parts = readable(p.line) ? lineParts(p.line) : { address: "a line that cannot be read", user: undefined, scheme: undefined };
      return {
        id: p.id,
        name: p.name,
        address: parts.address,
        user: parts.user,
        scheme: parts.scheme,
        addedAt: p.addedAt,
        lastUsedAt: p.lastUsedAt,
        uses: p.uses,
        last: p.last,
      };
    }),
    groups: lib.groups.map((g) => ({
      id: g.id,
      name: g.name,
      size: g.lines.length,
      rule: g.rule,
      n: g.n,
      addedAt: g.addedAt,
      lastUsedAt: g.lastUsedAt,
      uses: g.uses,
      summary: { shared: {}, sessions: 0 },
    })),
    picked: lib.picked,
  };
}

export function demoPlacesGet(): PlacesStart {
  return { view: view(), movedFromWindow: lib.moved };
}

const RULES: readonly Rule[] = ["on_failure", "every_minutes", "every_connection", "every_n", "random"];

/** The window's old storage, once: roughly what the library does, enough to look at. */
export function demoPlacesMove(old: WindowStorage): LibraryView {
  if (lib.moved) return view();
  lib.moved = true;
  for (const p of old.saved as Kept[]) {
    const line = p.line.trim();
    if (!lib.proxies.some((q) => q.line === line)) lib.proxies.push({ ...p, id: idOf(line), line });
  }
  for (const l of old.lists as (Omit<KeptGroup, "rule" | "lines"> & { rule: string; lines: unknown[] })[]) {
    const lines = l.lines.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    const rule = RULES.find((r) => r === l.rule) ?? "on_failure";
    if (lines.length) lib.groups.push({ ...l, name: l.name || "My group", lines, rule });
  }
  const t = old.target as { kind: string; line?: string; id?: string } | null;
  if (t?.kind === "fixed" && t.line) lib.picked = { kind: "proxy", id: demoPlacesAdd([t.line]).ids[0] };
  else if (t?.kind === "list" && t.id) lib.picked = { kind: "group", id: t.id };
  else if (t?.kind === "free") lib.picked = { ...(t as unknown as Extract<Place, { kind: "free" }>), kind: "free" };
  return view();
}

export function demoPlacesAdd(lines: string[]): { view: LibraryView; ids: string[] } {
  const now = Date.now();
  const ids: string[] = [];
  const fresh: Kept[] = [];
  for (const raw of [...new Set(lines.map((l) => l.trim()).filter(Boolean))]) {
    if (!readable(raw)) continue;
    const id = idOf(raw);
    if (!lib.proxies.some((p) => p.id === id) && !fresh.some((p) => p.id === id)) {
      fresh.push({ id, line: raw, addedAt: now, lastUsedAt: 0, uses: 0, last: checked.get(raw) });
    }
    ids.push(id);
  }
  lib.proxies.unshift(...fresh);
  return { view: view(), ids };
}

export function demoPlacesRename(id: string, name: string): LibraryView {
  const p = lib.proxies.find((x) => x.id === id);
  if (p) p.name = cleanName(name) || undefined;
  return view();
}

export function demoPlacesForget(id: string): LibraryView {
  lib.proxies = lib.proxies.filter((p) => p.id !== id);
  if (lib.picked?.kind === "proxy" && lib.picked.id === id) lib.picked = null;
  return view();
}

export function demoPlacesPick(place: Place | null): LibraryView {
  lib.picked = place;
  return view();
}

export function demoPlacesGroupSave(input: GroupInput): { view: LibraryView; ids: string[] } {
  const lines = [...new Set(input.lines.map((l) => l.trim()).filter(Boolean))].filter(readable);
  if (!lines.length) throw new Error("none of the lines can be read as a proxy");
  const n = input.rule === "every_minutes" || input.rule === "every_n" ? Math.max(1, input.n ?? 10) : undefined;
  const existing = input.id ? lib.groups.find((g) => g.id === input.id) : undefined;
  if (existing) {
    Object.assign(existing, { name: cleanName(input.name) || existing.name, lines, rule: input.rule, n });
    return { view: view(), ids: [existing.id] };
  }
  const id = `g${Date.now().toString(36)}${(groupSeq++).toString(36)}`;
  lib.groups.unshift({ id, name: cleanName(input.name) || "My group", lines, rule: input.rule, n, addedAt: Date.now(), lastUsedAt: 0, uses: 0 });
  return { view: view(), ids: [id] };
}

export function demoPlacesGroupForget(id: string): LibraryView {
  lib.groups = lib.groups.filter((g) => g.id !== id);
  if (lib.picked?.kind === "group" && lib.picked.id === id) lib.picked = null;
  return view();
}

export function demoPlacesGroupLines(id: string): string[] {
  const g = lib.groups.find((x) => x.id === id);
  if (!g) throw new Error("that group is not here any more");
  return [...g.lines];
}

export function demoPlacesGroupMembers(id: string, from: number, count: number): MemberView[] {
  return demoPlacesGroupLines(id)
    .slice(from, from + count)
    .map((line, i) => ({ index: from + i, ...lineParts(line) }));
}

export function demoPlacesProxyLine(id: string): string {
  const p = lib.proxies.find((x) => x.id === id);
  if (!p) throw new Error("that proxy is not saved here any more");
  return p.line;
}

export async function demoPlacesCheck(id: string): Promise<ProxyView> {
  const { demoCheckLine } = await import("./previewConnect");
  const p = lib.proxies.find((x) => x.id === id);
  if (!p) throw new Error("that proxy is not saved here any more");
  p.last = verdictOf(await demoCheckLine(p.line), Date.now());
  return view().proxies.find((x) => x.id === id)!;
}

/** The pretend relay's side: what a place dials, masked, and a use counted. */
export function demoPlaceForRelay(place: Place): { lines: string[]; rule?: Rule; n?: number } | null {
  const now = Date.now();
  if (place.kind === "proxy") {
    const p = lib.proxies.find((x) => x.id === place.id);
    if (!p) return null;
    p.uses += 1;
    p.lastUsedAt = now;
    lib.picked = place;
    return { lines: [maskLine(p.line)] };
  }
  if (place.kind === "group") {
    const g = lib.groups.find((x) => x.id === place.id);
    if (!g) return null;
    g.uses += 1;
    g.lastUsedAt = now;
    lib.picked = place;
    return { lines: g.lines.map(maskLine), rule: g.rule, n: g.n };
  }
  lib.picked = place;
  return { lines: [] };
}

/** `?demo=connect`'s group, made once: three example proxies (RFC 5737). */
export function demoSampleGroup(): Place {
  const found = lib.groups.find((g) => g.name === "Sample");
  if (found) return { kind: "group", id: found.id };
  const { ids } = demoPlacesGroupSave({
    name: "Sample",
    lines: ["user:pass@203.0.113.24:8080", "user:pass@198.51.100.24:8080", "user:pass@192.0.2.77:8080"],
    rule: "on_failure",
  });
  return { kind: "group", id: ids[0] };
}
