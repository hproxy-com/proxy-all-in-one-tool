// Three requests through the rotating proxy, each going out through the next proxy.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   npm install
//                         node fetch.mjs
import { fetch, ProxyAgent } from "undici";

const PROXY = "http://127.0.0.1:8080"; // where hproxy connect listens

async function trace() {
  // A ProxyAgent keeps its connection open for the next request, and with it one proxy.
  // One agent per request, closed afterwards, opens a new connection every time: the next proxy.
  // Keep one agent for all requests when you want to stay on the same address.
  const agent = new ProxyAgent(PROXY);
  try {
    const response = await fetch("https://hproxy.com/cdn-cgi/trace", { dispatcher: agent });
    const text = await response.text();
    const seen = Object.fromEntries(text.trim().split("\n").map((line) => line.split("=")));
    return `ip=${seen.ip} loc=${seen.loc}`;
  } finally {
    await agent.close();
  }
}

for (let i = 1; i <= 3; i++) {
  console.log(`${i}: ${await trace()}`);
}
