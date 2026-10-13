/* ============================================================
   OUR OWN GATEWAYS, as the popup needs to know them (1.0.3).
   ============================================================ */

/* Our own gateways answer HTTP and SOCKS5 on two ports of the same host,
   with the same login and the same settings in it (the backend's product
   registry, hproxy-backend/src/product_core/registry/seed.rs: Lite 6969 and
   9696, Mobile 8080 and 1080, Premium 9000 and 11000, Premium's sticky
   10000+ and 12000+). Chrome cannot send a SOCKS login, so a SOCKS5 line of
   ours that carries one goes through the same gateway's HTTP port: the line
   people copy from the dashboard works as it is, instead of answering
   nothing. Only our own names; nobody else's ports are guessed. */
const OUR_GATEWAYS = [
  { hosts: ["gw.hproxy.com", "gw-eu.hproxy.com"], socks: [[9696, 6969]] },
  { hosts: ["mobile-gb.hproxy.com"], socks: [[1080, 8080]] },
  { hosts: ["premium.hproxy.com"], socks: [[11000, 9000]], stickySocks: { from: 12000, to: 12010, http: 10000 } },
];
export function httpTwinPort(host, port) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  const p = Number(port);
  const gw = OUR_GATEWAYS.find((g) => g.hosts.includes(h));
  if (!gw) return null;
  const pair = gw.socks.find(([socks]) => socks === p);
  if (pair) return pair[1];
  const sticky = gw.stickySocks;
  if (sticky && p >= sticky.from && p <= sticky.to) return sticky.http + (p - sticky.from);
  return null;
}
