/* What the connection card says, worked out from the relay's status and the
   places: the switch's phase and the place it shows. Plain functions, so the
   words can be tested without a window (connection.tsx calls them). */

import { countryName } from "./checker";
import { addressInUse, aboutWords, freeCountryName, groupWords, proxyTitle, spacedN } from "./connect";
import { lastCheckWords, samePlace, type GroupView, type Place, type ProxyView } from "./places";
import type { ConnectStatus } from "./tauri";
import type { Phase, TargetView } from "../components/connect/ConnectionCard";

/** What is under way. "switching" is a connect while already connected: the
    relay keeps running and only the place behind it changes. */
export type Busy = "" | "connecting" | "switching" | "stopping" | "rotating" | "probing";

/** The switch's phase: what is under way, else on or off. A probe shows as on. */
export function phaseOf(busy: Busy, running: boolean): Phase {
  if (busy === "connecting") return "connecting";
  if (busy === "switching") return "switching";
  if (busy === "stopping") return "leaving";
  if (busy === "rotating") return "rotating";
  return running ? "on" : "off";
}

/** What the card needs besides the place itself. */
export type PlaceViewInput = {
  proxies: ProxyView[];
  groups: GroupView[];
  status: ConnectStatus | null;
  /** The place the relay goes through, while it runs. */
  connected: Place | null;
};

/** The card's name and line for a place; when the place is not among the
    ones read (not read yet, or gone), what the relay says it goes through. */
export function placeView(shown: Place | null, { proxies, groups, status, connected }: PlaceViewInput): TargetView | null {
  const running = status?.running ?? false;
  if (shown?.kind === "proxy") {
    const p = proxies.find((x) => x.id === shown.id);
    if (p) {
      return {
        kind: "proxy",
        // The name it was given, or the session it holds, with the address
        // under it; or the address.
        name: proxyTitle(p),
        cc: p.last?.cc ?? p.about?.country?.toLowerCase(),
        sub: [
          p.name || p.about?.session ? p.address : undefined,
          // What the line targets says more than a login a hundred lines share.
          p.about ? aboutWords(p.about) : p.user ? `login ${p.user}` : "no login",
          p.last
            ? (lastCheckWords(p.last)?.text ?? (p.last.latencyMs != null ? `${p.last.latencyMs} ms when last checked` : "working"))
            : undefined,
          p.last?.place,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }
  }
  if (shown?.kind === "group") {
    const g = groups.find((x) => x.id === shown.id);
    // Connected through it: which of its proxies is in use.
    const member = running && samePlace(connected, shown) ? status?.source?.member : null;
    if (g) return { kind: "group", name: g.name, sub: member != null ? `Proxy ${spacedN(member + 1)} of ${spacedN(g.size)} · ${groupWords(g)}` : groupWords(g) };
  }
  if (shown?.kind === "free") {
    const proto = shown.socks5 ? "SOCKS5" : "HTTP";
    if (shown.exit) {
      // The relay swaps a free proxy that dies, and "new IP" swaps it too:
      // while connected, the card says when the one in use is another.
      const inUse = running && status?.source?.kind === "pool" ? addressInUse(status.source.in_use) : null;
      const where = countryName(shown.exitCountry);
      return {
        kind: "free",
        name: `Free · ${shown.exit}`,
        cc: shown.exitCountry?.toLowerCase(),
        sub:
          inUse && inUse !== shown.exit
            ? `Now through ${inUse}, swapped in for the one you picked`
            : `A public ${proto} proxy${where ? ` in ${where}` : ""}, swapped if it stops`,
      };
    }
    return {
      kind: "free",
      name: shown.country ? `Free · ${freeCountryName(shown.country)}` : "Free · fastest anywhere",
      cc: shown.country ? shown.country.toLowerCase() : undefined,
      sub: `A public ${proto} exit, swapped for a fresh one when it dies`,
    };
  }
  // The places are not read yet, or the place is gone: what the relay says.
  if (running && status?.source) {
    const s = status.source;
    return {
      kind: s.kind === "pool" ? "free" : s.kind === "list" ? "group" : "proxy",
      name: s.kind === "pool" ? "Free proxy" : s.kind === "list" ? `A group of ${s.size ?? "your"} proxies` : s.in_use,
      sub: s.kind === "pool" ? (s.detail ?? undefined) : s.kind === "list" ? (s.rotation ?? undefined) : undefined,
    };
  }
  return null;
}
