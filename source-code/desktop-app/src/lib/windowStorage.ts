/* What the window kept itself before the library existed: saved proxies,
   groups and the picked place in its localStorage, passwords and all. The
   library takes them over once (src-tauri/src/places.rs,
   places_move_from_window); after that these keys are never read again. They
   are left where they are rather than deleted, so nothing can be lost in the
   move, and an older version of the app still finds what it kept. */

const SAVED_KEY = "hproxy-checker-saved-proxies";
const LISTS_KEY = "hproxy-checker-saved-lists";
const TARGET_KEY = "hproxy-checker-connect-target";

/** The old storage, in the shape the library reads it (`WindowStorage` in
    proxy-engine/hproxy-places/src/library.rs). Entries that are plainly not
    what they should be are left out here; the library reads each of the rest
    on its own as well, so one damaged entry never stops the others. */
export type WindowStorage = { saved: unknown[]; lists: unknown[]; target: unknown | null };

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readWindowStorage(): WindowStorage {
  const saved = read(SAVED_KEY);
  const lists = read(LISTS_KEY);
  const target = read(TARGET_KEY);
  return {
    saved: Array.isArray(saved) ? saved.filter((p) => isObject(p) && typeof p.line === "string" && p.line.trim() !== "") : [],
    lists: Array.isArray(lists) ? lists.filter((l) => isObject(l) && typeof l.id === "string" && Array.isArray(l.lines)) : [],
    target: isTarget(target) ? target : null,
  };
}

/** A picked place in the old storage's words: a line, a list's id, or a free country. */
function isTarget(t: unknown): boolean {
  if (!isObject(t)) return false;
  if (t.kind === "fixed") return typeof t.line === "string" && t.line.trim() !== "";
  if (t.kind === "list") return typeof t.id === "string";
  return t.kind === "free" && (t.country === undefined || typeof t.country === "string");
}
