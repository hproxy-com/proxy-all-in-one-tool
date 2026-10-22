import { useSyncExternalStore } from "react";
import type { RelayStats } from "./tauri";

/* The relay's traffic as it moves: its byte counters, the speed made from them, and the clock,
   once a second while connected (components/connect/useRelayStatus.ts writes it). Only what shows
   them reads it (the Connect page, components/connect/ConnectPanel.tsx), so the rest of the window
   is not drawn again every second: with 300 saved proxies that was 40 ms of script a second, the
   list redrawn even behind another page (measured in a production build, 2026-10-23). */

export type Live = {
  /** The clock, once a second while connected. */
  now: number;
  /** Bytes a second, from the last two readings of the counters. */
  rate: { up: number; down: number } | null;
  stats: RelayStats | null;
};

let live: Live = { now: Date.now(), rate: null, stats: null };
const listeners = new Set<() => void>();

export function readLive(): Live {
  return live;
}

export function setLive(next: Live): void {
  live = next;
  for (const l of listeners) l();
}

/** The traffic as it moves; a component that reads it is drawn again once a second while connected. */
export function useLive(): Live {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    readLive,
    readLive,
  );
}
