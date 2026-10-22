/* What the Proxies page's top right asks of My proxies (since 2026-10-22): Add, and the big blue
   Paste what I copied. The buttons sit in the page's head
   (ProxiesPage.tsx) and the box they open lives in the list (Destinations.tsx), so a press is an
   event the list listens for. */

export const PROXIES_ASK = "hproxy:proxies-ask";
export type ProxiesAsk = "paste" | "add";

export function askProxies(what: ProxiesAsk): void {
  window.dispatchEvent(new CustomEvent<ProxiesAsk>(PROXIES_ASK, { detail: what }));
}
