// A Crawlee crawler through the rotating proxy: three pages, each through the next proxy.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   npm install
//                         node crawlee.mjs
//
// Crawlee rotates over the proxies it is given; with hproxy it is given one, and hproxy rotates
// behind it, over as many proxies as your list holds.
import { CheerioCrawler, ProxyConfiguration } from "crawlee";

const PROXY = "http://127.0.0.1:8080"; // where hproxy connect listens

const crawler = new CheerioCrawler({
  proxyConfiguration: new ProxyConfiguration({ proxyUrls: [PROXY] }),
  // One page at a time, and no session that keeps its connection: every page opens a new
  // connection, so it goes out through the next proxy.
  maxConcurrency: 1,
  useSessionPool: false,
  persistCookiesPerSession: false,
  additionalMimeTypes: ["text/plain"],
  async requestHandler({ request, body }) {
    const seen = Object.fromEntries(String(body).trim().split("\n").map((line) => line.split("=")));
    console.log(`${request.userData.n}: ip=${seen.ip} loc=${seen.loc}`);
  },
});

await crawler.run(
  [1, 2, 3].map((n) => ({ url: `https://hproxy.com/cdn-cgi/trace?n=${n}`, userData: { n }, uniqueKey: `trace-${n}` })),
);
