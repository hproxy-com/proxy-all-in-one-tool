/* Connecting without the Connect screen: what the tray icon's "Connect" uses
   (src-tauri/src/tray.rs asks the window, which keeps running while hidden).
   The same rules as the screen: the place picked last (lib/connect.ts,
   `loadTarget`), a saved list read from this computer, the free pool. */

import { loadTarget, type Target } from "./connect";
import { listUsed, loadLists, saveLists, type SavedList } from "./saved";
import { connectStart, connectStatus, thisDevice, type ConnectSourceArg } from "./tauri";

/** What the relay is asked for, for a place: a string when it cannot be done. */
export function sourceOfTarget(t: Target, lists: SavedList[]): ConnectSourceArg | string {
  if (t.kind === "fixed") return { kind: "fixed", line: t.line.trim() };
  if (t.kind === "list") {
    const l = lists.find((x) => x.id === t.id);
    if (!l) return `That list is not on ${thisDevice()} any more. Pick another place.`;
    if (!l.lines.length) return "That list is empty. Edit it and add some proxies.";
    return { kind: "list", lines: l.lines, rotation: { rule: l.rule, n: l.rule === "every_n" ? l.n : undefined } };
  }
  // A proxy picked from the Free tab's list starts the relay on it; the relay
  // tests it first and searches the pool when it stopped working since.
  return t.exit
    ? { kind: "free", country: t.country || null, socks5: t.socks5, exit: t.exit }
    : { kind: "free", country: t.country || null, socks5: t.socks5 };
}

/** Connect to the place picked last, with the system proxy set, as the
    screen does by default. Nothing picked yet: nothing happens, and the
    window is where to pick one. */
export async function connectRemembered(probeUrl: string): Promise<string | null> {
  const t = loadTarget();
  if (!t) return "Pick a place on the Connect tab first.";
  if ((await connectStatus()).running) return null;
  const lists = loadLists();
  const source = sourceOfTarget(t, lists);
  if (typeof source === "string") return source;
  await connectStart(source, true, undefined, probeUrl);
  if (t.kind === "list") saveLists(listUsed(lists, t.id));
  return null;
}
