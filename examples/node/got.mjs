// Three requests through the rotating proxy with got, each going out through the next proxy.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   npm install
//                         node got.mjs
import got from "got";
import { HttpsProxyAgent } from "hpagent";

const PROXY = "http://127.0.0.1:8080"; // where hproxy connect listens

// keepAlive: false, so every request opens its own connection: the next proxy.
// Set it to true to stay on the same address.
const agent = new HttpsProxyAgent({ proxy: PROXY, keepAlive: false });

for (let i = 1; i <= 3; i++) {
  const text = await got("https://hproxy.com/cdn-cgi/trace", {
    agent: { https: agent },
    timeout: { request: 30_000 },
  }).text();
  const seen = Object.fromEntries(text.trim().split("\n").map((line) => line.split("=")));
  console.log(`${i}: ip=${seen.ip} loc=${seen.loc}`);
}
