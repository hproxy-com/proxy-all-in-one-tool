/* Every paste is its own group in My proxies (since 2026-10-22): easier to delete, to edit, and to
   know when they were added.

   A paste is the proxies saved in one go. The library stamps every one of them with the same added
   time (proxy-engine/hproxy-places, `add_proxies`), so the pastes are read from that time: the ones
   made before this day show as their own groups too, and nothing new is kept anywhere. A proxy added
   on its own goes with the others added one at a time. */

import type { ProxyView } from "./places";

/** The proxies added one at a time, as one list of their own. */
export const ONE_AT_A_TIME = "one-at-a-time";

export type Paste = {
  /** `paste-<added time>`, or ONE_AT_A_TIME. */
  key: string;
  /** When they were saved (Unix ms); 0 for the ones added one at a time. */
  addedAt: number;
  /** The name they share ("Shop" for "Shop 1" … "Shop 12"), or "". */
  name: string;
  proxies: ProxyView[];
};

/** The pastes of a list, in the list's own order: a paste stands where its first proxy does. */
export function pastesOf(list: ProxyView[]): Paste[] {
  const together = new Map<number, number>();
  for (const p of list) together.set(p.addedAt, (together.get(p.addedAt) ?? 0) + 1);
  const pastes = new Map<string, Paste>();
  for (const p of list) {
    const paste = p.addedAt > 0 && (together.get(p.addedAt) ?? 0) > 1;
    const key = paste ? `paste-${p.addedAt}` : ONE_AT_A_TIME;
    let at = pastes.get(key);
    if (!at) {
      at = { key, addedAt: paste ? p.addedAt : 0, name: "", proxies: [] };
      pastes.set(key, at);
    }
    at.proxies.push(p);
  }
  for (const paste of pastes.values()) if (paste.key !== ONE_AT_A_TIME) paste.name = sharedName(paste.proxies);
  return [...pastes.values()];
}

/** The name every proxy of a paste carries, its number taken off: "Shop" for "Shop 1" … "Shop 12";
    "" when they carry none or different ones. */
export function sharedName(proxies: ProxyView[]): string {
  const bases = proxies.map((p) => (p.name ?? "").replace(/\s+\d+$/, "").trim());
  return bases[0] && bases.every((b) => b === bases[0]) ? bases[0] : "";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a paste came in, in this computer's time: "today at 14:05", "yesterday at 09:12",
    "19 Oct at 03:12", "19 Oct 2025 at 03:12". */
export function pastedWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day(d) === day(today)) return `today at ${time}`;
  if (day(d) === day(yesterday)) return `yesterday at ${time}`;
  const year = d.getFullYear() === today.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} at ${time}`;
}

/** A paste's title: its name, else when it came in ("Pasted today at 14:05"). */
export function pasteTitle(paste: Paste, now = Date.now()): string {
  if (paste.key === ONE_AT_A_TIME) return "Added one at a time";
  return paste.name || `Pasted ${pastedWhen(paste.addedAt, now)}`;
}
