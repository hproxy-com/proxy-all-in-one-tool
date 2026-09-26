/* ============================================================
   HOW MANY FREE EXITS WORK IN A REAL CHROME?

     node tests/e2e/free-pool-health.mjs [--count=30] [--country=US] [--json=<file>]

   The engine calls an exit alive when our echo comes back through it.
   Chrome asks more: HTTPS must reach the real site with the real site's
   certificate. This run takes the exits in the order Quick Connect gets
   them (/api/vpn/pool is the same ranking /api/vpn/next walks), connects
   each one with the extension's own code in Chrome for Testing, and loads
   one HTTPS page and one plain-HTTP page through it.

   Nothing is reported back to the pool, nothing is written anywhere but
   the --json file.
   ============================================================ */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachServiceWorker, extensionIdFromKey, launchWithExtension, navigate, newPage } from "./cdp.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const EXT_ID = extensionIdFromKey(manifest.key);
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const COUNT = Math.min(200, Number(argv.count) || 30);
const COUNTRY = argv.country ? `&country=${encodeURIComponent(String(argv.country))}` : "";

const HTTPS_PAGE = "https://www.cloudflare.com/cdn-cgi/trace";
const HTTP_PAGE = "http://1.1.1.1/cdn-cgi/trace";

function verdictOf(error) {
  if (!error) return "works";
  if (/ERR_CERT_|ERR_SSL_/.test(error)) return "re-signs HTTPS (certificate not the site's)";
  if (/ERR_TUNNEL_CONNECTION_FAILED/.test(error)) return "refuses the HTTPS tunnel";
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|ERR_CONNECTION_REFUSED/.test(error)) return "down";
  if (/timeout|ERR_TIMED_OUT|no answer/i.test(error)) return "too slow (over 12 s)";
  if (/ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET/.test(error)) return "drops the connection";
  if (/no ip= line/.test(error)) return "answers with some other page";
  return error;
}

const res = await fetch(`https://hproxy.com/api/vpn/pool?limit=${COUNT}${COUNTRY}`, { cache: "no-store" });
const pool = (await res.json())?.proxies ?? [];
console.log(`${pool.length} exits from /api/vpn/pool, in Quick Connect order\n`);

const { cdp, close } = await launchWithExtension({ extensionDir: EXT, headless: true });
const sw = await attachServiceWorker(cdp, EXT_ID);
const page = await newPage(cdp);
await cdp.send("Security.enable", {}, page.sessionId);
let lastCert = null;
cdp.on((m) => {
  if (m.sessionId === page.sessionId && m.method === "Security.visibleSecurityStateChanged") {
    const c = m.params.visibleSecurityState?.certificateSecurityState;
    if (c) lastCert = { issuer: c.issuer, subject: c.subjectName, error: c.certificateNetworkError };
  }
});

async function load(url) {
  const t = Date.now();
  lastCert = null;
  const nav = await navigate(cdp, page.sessionId, url, 12_000);
  if (!nav.ok) return { error: nav.error, ms: Date.now() - t, cert: lastCert };
  const text = await cdp.evaluate(page.sessionId, "document.body ? document.body.innerText : ''").catch(() => "");
  const ip = /^ip=(.+)$/m.exec(text || "")?.[1]?.trim();
  return ip ? { ip, ms: Date.now() - t } : { error: "no ip= line", ms: Date.now() - t };
}

const rows = [];
try {
  for (const [i, exit] of pool.entries()) {
    const scheme = await cdp.evaluate(sw.sessionId, `schemeForExit(${JSON.stringify(exit)}, "")`);
    await cdp.evaluate(
      sw.sessionId,
      `connectProxy(${JSON.stringify({ scheme, host: exit.ip, port: exit.port })}, { mode: "pin", label: "health check" })`,
    );
    const https = await load(HTTPS_PAGE);
    const http = await load(HTTP_PAGE);
    const row = {
      rank: i + 1,
      exit: `${exit.ip}:${exit.port}`,
      country: exit.country_code || "",
      protocols: (exit.protocols || []).join("/"),
      chrome_scheme: scheme,
      uptime_7d: exit.uptime_7d,
      https: verdictOf(https.error),
      https_ms: https.error ? null : https.ms,
      https_cert_issuer: https.cert?.issuer || null,
      http: verdictOf(http.error),
    };
    rows.push(row);
    console.log(
      `${String(row.rank).padStart(2)}  ${row.exit.padEnd(22)} ${row.country.padEnd(3)} ${scheme.padEnd(7)} HTTPS: ${row.https}${row.https_ms ? ` (${row.https_ms} ms)` : ""}${row.https_cert_issuer ? ` [cert by: ${row.https_cert_issuer}]` : ""} | HTTP: ${row.http}`,
    );
  }
} finally {
  await cdp.evaluate(sw.sessionId, "disconnect()").catch(() => {});
  await close();
}

const tally = rows.reduce((m, r) => ((m[r.https] = (m[r.https] || 0) + 1), m), {});
const works = rows.filter((r) => r.https === "works").length;
console.log(`\nHTTPS in Chrome: ${works} of ${rows.length} exits work (${Math.round((100 * works) / Math.max(1, rows.length))}%)`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
const firstGood = rows.findIndex((r) => r.https === "works");
console.log(`Quick Connect's first working exit is number ${firstGood + 1} in line.`);

if (argv.json) {
  writeFileSync(
    resolve(String(argv.json)),
    JSON.stringify({ measured_at: new Date().toISOString(), https_page: HTTPS_PAGE, http_page: HTTP_PAGE, count: rows.length, works, tally, rows }, null, 2),
  );
}
