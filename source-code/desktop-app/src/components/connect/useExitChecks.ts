import { useEffect, useState } from "react";
import { leakDns, type DnsLeak } from "../../lib/tauri";
import { cachedSet, fraudScoresAll, type FraudSet } from "../../lib/fraud";
import type { Settings } from "../../lib/settings";

/* The checks on the address you appear as, once per new exit: its fraud
   scores (Settings, Fraud score) and the DNS leak test. `exitIp` is null
   while not connected or while the last probe failed. */
export function useExitChecks(exitIp: string | null, settings: Pick<Settings, "fraudOnConnect" | "fraudServices" | "fraudKeys">) {
  // Every service turned on, from the session's scores when they were asked before.
  const [exitFraud, setExitFraud] = useState<FraudSet | null>(null);
  const { fraudOnConnect, fraudServices, fraudKeys } = settings;
  const servicesKey = fraudServices.join(",");
  useEffect(() => {
    if (!exitIp || !fraudOnConnect) {
      setExitFraud(null);
      return;
    }
    const known = cachedSet(fraudServices, exitIp);
    setExitFraud(known ?? null);
    if (known) return;
    let live = true;
    void fraudScoresAll([exitIp], fraudServices, fraudKeys).then((found) => {
      if (live) setExitFraud(found.get(exitIp) ?? null);
    });
    return () => {
      live = false;
    };
    // servicesKey stands for the list, which is a new array after every save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitIp, fraudOnConnect, servicesKey, fraudKeys]);

  // Which resolver the proxy looks names up with, and where: again after "Test now".
  const [dnsLeak, setDnsLeak] = useState<DnsLeak | null>(null);
  const [leakRun, setLeakRun] = useState(0);
  useEffect(() => {
    setDnsLeak(null);
    if (!exitIp) return;
    let live = true;
    void leakDns()
      .then((found) => live && setDnsLeak(found))
      .catch((e: unknown) => live && setDnsLeak({ state: "unavailable", why: String(e) }));
    return () => {
      live = false;
    };
  }, [exitIp, leakRun]);

  return {
    exitFraud,
    dnsLeak,
    /** Run the DNS leak test again. */
    retestDns: () => setLeakRun((n) => n + 1),
  };
}
