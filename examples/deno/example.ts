// Three requests through the rotating proxy with Deno, each going out through the next proxy.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   deno run --allow-net example.ts

const PROXY = "http://127.0.0.1:8080"; // where hproxy connect listens

async function trace(): Promise<string> {
  // A client keeps its connection open for the next request, and with it one proxy. One client per
  // request, closed afterwards, opens a new connection every time: the next proxy. Keep one client
  // when you want to stay on the same address.
  const client = Deno.createHttpClient({ proxy: { url: PROXY } });
  try {
    const response = await fetch("https://hproxy.com/cdn-cgi/trace", { client });
    const text = await response.text();
    const seen = Object.fromEntries(text.trim().split("\n").map((line) => line.split("=")));
    return `ip=${seen.ip} loc=${seen.loc}`;
  } finally {
    client.close();
  }
}

for (let i = 1; i <= 3; i++) {
  console.log(`${i}: ${await trace()}`);
}
