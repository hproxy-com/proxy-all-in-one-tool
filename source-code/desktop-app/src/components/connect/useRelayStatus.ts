import { useCallback, useEffect, useRef, useState } from "react";
import { connectStatus, onRelayChanged, zoneStatus, type ConnectStatus, type ZoneStatus } from "../../lib/tauri";
import { rateBetween, type ByteReading } from "../../lib/connect";
import { readLive, setLive } from "../../lib/liveRelay";
import { placesStore } from "../../lib/placesStore";

/* The relay as the window sees it: its status read at start, once a second
   while connected (cheap, the status is in memory on the Rust side), and
   whenever the tray changes it. With it the time zone match and the live speed.

   The traffic moves every second; the rest of a status seldom does. So a
   reading becomes new state only when something besides the traffic changed
   (the place, the probe's answer, a switch), and the traffic, its speed and
   the second-by-second clock go to lib/liveRelay.ts, which only the Connect
   page reads: until 2026-10-23 every page was drawn again once a second while
   connected, the list of saved proxies too, even behind another page. The
   window's own clock moves once a minute ("pasted 5 minutes ago"). */

const POLL_MS = 1000;
const CLOCK_MS = 60_000;

/** Two statuses alike but for their traffic. */
function sameButTraffic(a: ConnectStatus, b: ConnectStatus): boolean {
  return JSON.stringify({ ...a, stats: null }) === JSON.stringify({ ...b, stats: null });
}

export function useRelayStatus() {
  const [status, setStatusState] = useState<ConnectStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const running = status?.running ?? false;

  // A reading of the relay: new state when more than its traffic changed; the traffic and the
  // speed made from it go to the live store either way.
  const lastReading = useRef<ByteReading | null>(null);
  const setStatus = useCallback((next: ConnectStatus) => {
    setStatusState((prev) => (prev && sameButTraffic(prev, next) ? prev : next));
    const stats = next.running ? (next.stats ?? null) : null;
    let rate: { up: number; down: number } | null = null;
    if (stats) {
      const reading: ByteReading = { at: Date.now(), up: stats.bytes_up, down: stats.bytes_down };
      rate = rateBetween(lastReading.current, reading) ?? readLive().rate;
      lastReading.current = reading;
    } else {
      lastReading.current = null;
    }
    setLive({ now: Date.now(), rate, stats });
  }, []);

  useEffect(() => {
    void connectStatus().then(setStatus).catch(() => {});
  }, [setStatus]);

  // The window's clock, once a minute.
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(h);
  }, []);

  // The time zone match (src-tauri/src/timezone.rs does it; the leak check
  // shows it): read at start, on every connect and disconnect, and with the
  // status while connected; new state only when it changed.
  const [zone, setZoneState] = useState<ZoneStatus | null>(null);
  const setZone = useCallback((next: ZoneStatus) => {
    setZoneState((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);
  useEffect(() => {
    void zoneStatus().then(setZone).catch(() => {});
  }, [running, setZone]);

  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => {
      void connectStatus().then(setStatus).catch(() => {});
      void zoneStatus().then(setZone).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(h);
  }, [running, setStatus, setZone]);

  // A change made from the tray icon shows here too: the connection, and the
  // places (a connect there counts a use and becomes the pick).
  useEffect(() => {
    let off: (() => void) | undefined;
    void onRelayChanged(() => {
      void connectStatus().then(setStatus).catch(() => {});
      void placesStore.refresh().catch(() => {});
    }).then((u) => (off = u));
    return () => off?.();
  }, [setStatus]);

  return {
    status,
    setStatus,
    running,
    /** What the relay goes through now, whoever started it (this window or the tray). */
    connected: running ? (status?.place ?? null) : null,
    zone,
    setZone,
    /** The window's clock, once a minute; the Connect page reads the second-by-second one from
        lib/liveRelay.ts. */
    now,
  };
}
