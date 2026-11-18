// Three requests through the rotating proxy with Bun, each going out through the next proxy.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   bun example.ts

const PROXY = "http://127.0.0.1:8080"; // where hproxy connect listens

for (let i = 1; i <= 3; i++) {
  // keepalive: false closes the connection after the answer, so the next request opens a new one:
  // the next proxy. Leave it out to stay on the same address.
  const response = await fetch("https://hproxy.com/cdn-cgi/trace", { proxy: PROXY, keepalive: false });
  const text = await response.text();
  const seen = Object.fromEntries(text.trim().split("\n").map((line) => line.split("=")));
  console.log(`${i}: ip=${seen.ip} loc=${seen.loc}`);
}
