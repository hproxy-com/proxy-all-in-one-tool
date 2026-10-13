import { useEffect, useRef, useState } from "react";
import { connectStatus, onRelayChanged, zoneStatus, type ConnectStatus, type ZoneStatus } from "../../lib/tauri";
import { rateBetween, type ByteReading } from "../../lib/connect";
import { placesStore } from "../../lib/placesStore";

/* The relay as the window sees it: its status read at start, once a second
   while connected (cheap, the status is in memory on the Rust side), and
   whenever the tray changes it. With it the time zone match and the live speed. */

const POLL_MS = 1000;

export function useRelayStatus() {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const running = status?.running ?? false;

  useEffect(() => {
    void connectStatus().then(setStatus).catch(() => {});
  }, []);

  // The time zone match (src-tauri/src/timezone.rs does it; the leak check
  // shows it): read at start, on every connect and disconnect, and with the
  // status while connected.
  const [zone, setZone] = useState<ZoneStatus | null>(null);
  useEffect(() => {
    void zoneStatus().then(setZone).catch(() => {});
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => {
      setNow(Date.now());
      void connectStatus().then(setStatus).catch(() => {});
      void zoneStatus().then(setZone).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(h);
  }, [running]);

  // The live speed: the relay's byte counters, turned into bytes a second.
  const lastReading = useRef<ByteReading | null>(null);
  const [rate, setRate] = useState<{ up: number; down: number } | null>(null);
  useEffect(() => {
    const s = status?.stats;
    if (!status?.running || !s) {
      lastReading.current = null;
      setRate(null);
      return;
    }
    const reading: ByteReading = { at: Date.now(), up: s.bytes_up, down: s.bytes_down };
    const r = rateBetween(lastReading.current, reading);
    lastReading.current = reading;
    if (r) setRate(r);
  }, [status]);

  // A change made from the tray icon shows here too: the connection, and the
  // places (a connect there counts a use and becomes the pick).
  useEffect(() => {
    let off: (() => void) | undefined;
    void onRelayChanged(() => {
      void connectStatus().then(setStatus).catch(() => {});
      void placesStore.refresh().catch(() => {});
    }).then((u) => (off = u));
    return () => off?.();
  }, []);

  return {
    status,
    setStatus,
    running,
    /** What the relay goes through now, whoever started it (this window or the tray). */
    connected: running ? (status?.place ?? null) : null,
    zone,
    setZone,
    rate,
    /** The clock, ticking once a second while connected. */
    now,
  };
}
