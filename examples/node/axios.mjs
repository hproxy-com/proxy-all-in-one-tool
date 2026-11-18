// Three requests through the rotating proxy with axios, each going out through the next proxy.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   npm install
//                         node axios.mjs
//
// axios's own `proxy` option sends HTTPS requests in a form many proxies refuse, so the proxy goes
// in an agent that opens a proper tunnel (https-proxy-agent), and axios's own option is switched off.
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const PROXY = "http://127.0.0.1:8080"; // where hproxy connect listens

// The agent keeps no connection open between requests, so every request opens a new one: the next
// proxy. Pass { keepAlive: true } as its second argument to stay on the same address.
const agent = new HttpsProxyAgent(PROXY);

for (let i = 1; i <= 3; i++) {
  const { data } = await axios.get("https://hproxy.com/cdn-cgi/trace", {
    httpsAgent: agent,
    proxy: false,
    timeout: 30_000,
    responseType: "text",
  });
  const seen = Object.fromEntries(data.trim().split("\n").map((line) => line.split("=")));
  console.log(`${i}: ip=${seen.ip} loc=${seen.loc}`);
}
