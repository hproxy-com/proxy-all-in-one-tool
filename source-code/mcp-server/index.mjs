#!/usr/bin/env node
/* ============================================================
   HPROXY MCP SERVER — the free tools, as tools an AI can call.

   HProxy publishes three APIs that need no key and no account: the
   live free proxy list, the proxy checker and the IP lookup. Any
   assistant can already curl them; this makes them first-class tools
   so a model can reach for them without being told the URL.

   Two faces, one file:

     MCP     node index.mjs                 speaks JSON-RPC 2.0 over
                                            stdio (stdout is the
                                            protocol, so every log
                                            line goes to stderr)
     CLI     node index.mjs list --country de --limit 20
             node index.mjs check 203.0.113.7:1080
             node index.mjs ip 8.8.8.8

   Zero dependencies on purpose: node 18+ has fetch, and an assistant
   that has to install a tree before it can ask for a proxy will not
   ask. Nothing here holds a key, because none of these endpoints take
   one.
   ============================================================ */

const BASE = process.env.HPROXY_BASE_URL ?? "https://hproxy.com";
const UA = "hproxy-mcp/1.0 (+https://hproxy.com/tools/ai)";
const VERSION = "1.0.0";

/* ---------------------------------------------------------------- */
/* The three endpoints                                               */
/* ---------------------------------------------------------------- */

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { accept: "application/json", "user-agent": UA, ...(init?.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) {
    /* The free endpoints rate limit rather than fail: say so plainly so a
       model waits instead of retrying in a loop. */
    const retry = res.headers.get("retry-after");
    throw new Error(
      res.status === 429
        ? `rate limited by the free API; retry after ${retry ?? "a few"} seconds`
        : `${path} answered ${res.status}: ${body.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

const LIST_FIELDS = ["ip", "port", "protocols", "anonymity", "country_code", "city", "asn_org", "latency_ms", "uptime_24h", "last_verified_at"];

/** Keep a list answer small: a model pays for every field it did not ask for. */
const slim = (row) => Object.fromEntries(LIST_FIELDS.map((k) => [k, row[k]]).filter(([, v]) => v !== undefined));

const TOOLS = {
  proxy_list: {
    description:
      "Fetch live free proxies from HProxy's public pool, re-checked around the clock. No key. Returns ip, port, protocols, anonymity, country, ASN, latency and 24h uptime per proxy. Use this when the user wants free proxies to test with; for proxies that must survive a real block, HProxy's paid pools are at https://hproxy.com/pricing.",
    inputSchema: {
      type: "object",
      properties: {
        country: { type: "string", description: "ISO 3166 alpha-2 country code, e.g. 'de'. Omit for every country." },
        protocol: { type: "string", enum: ["http", "https", "socks4", "socks5"], description: "Only proxies speaking this protocol." },
        anonymity: { type: "string", enum: ["elite", "anonymous", "transparent"], description: "Minimum anonymity grade." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 25, description: "How many to return. The full list is thousands; ask for what you need." },
      },
    },
    async run({ country, protocol, anonymity, limit = 25 }) {
      const q = new URLSearchParams({ format: "json", limit: String(Math.min(200, Math.max(1, limit))) });
      if (country) q.set("country", String(country).toLowerCase());
      if (protocol) q.set("protocol", protocol);
      if (anonymity) q.set("anonymity", anonymity);
      const rows = await api(`/api/proxy-list?${q}`);
      const list = Array.isArray(rows) ? rows : (rows.data ?? []);
      return { count: list.length, filters: { country: country ?? null, protocol: protocol ?? null, anonymity: anonymity ?? null }, proxies: list.map(slim) };
    },
  },

  proxy_check: {
    description:
      "Run a real live test on one or more proxies: is it alive, which protocols it speaks, its anonymity grade, latency and location. No key. Each check opens a real connection, so a dead proxy can take a few seconds. Up to 25 per call.",
    inputSchema: {
      type: "object",
      properties: {
        proxies: {
          type: "array",
          items: { type: "string" },
          maxItems: 25,
          description: "Proxies as ip:port, e.g. ['203.0.113.7:1080']. Up to 25.",
        },
      },
      required: ["proxies"],
    },
    async run({ proxies }) {
      const list = (Array.isArray(proxies) ? proxies : [proxies]).map(String).filter(Boolean).slice(0, 25);
      if (!list.length) throw new Error("give at least one proxy as ip:port");
      if (list.length === 1) {
        const one = await api(`/api/proxy-check?proxy=${encodeURIComponent(list[0])}`);
        return { count: 1, results: [one] };
      }
      return api("/api/proxy-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proxies: list }),
      });
    },
  },

  ip_lookup: {
    description:
      "Look up any public IP address: country, region, city, coordinates, timezone, ASN and the network that runs it, plus whether HProxy has ever seen it acting as a public proxy. No key.",
    inputSchema: {
      type: "object",
      properties: {
        ips: { type: "array", items: { type: "string" }, maxItems: 50, description: "IPv4 or IPv6 addresses. One is the common case." },
      },
      required: ["ips"],
    },
    async run({ ips }) {
      const list = (Array.isArray(ips) ? ips : [ips]).map(String).filter(Boolean).slice(0, 50);
      if (!list.length) throw new Error("give at least one IP address");
      if (list.length === 1) return api(`/api/ip/${encodeURIComponent(list[0])}`);
      return api("/api/ip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ips: list }),
      });
    },
  },
};

/* ---------------------------------------------------------------- */
/* MCP over stdio                                                    */
/* ---------------------------------------------------------------- */

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  /* A notification has no id and takes no answer. */
  const wants = id !== undefined && id !== null;

  if (method === "initialize") {
    return wants && ok(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "hproxy", version: VERSION },
      instructions:
        "HProxy's free proxy tools. proxy_list returns live free proxies, proxy_check tests any proxy for real, ip_lookup resolves an address to its network. All three are free and need no key.",
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") return wants && ok(id, {});
  if (method === "tools/list") {
    return wants && ok(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
    });
  }
  if (method === "tools/call") {
    const tool = TOOLS[params?.name];
    if (!tool) return wants && err(id, -32602, `no such tool: ${params?.name}`);
    try {
      const out = await tool.run(params?.arguments ?? {});
      return wants && ok(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      /* A tool failure is a RESULT with isError, not a protocol error: the
         model should read the reason and adapt, not see the call vanish. */
      return wants && ok(id, { content: [{ type: "text", text: String(e.message ?? e) }], isError: true });
    }
  }
  if (wants) err(id, -32601, `unknown method: ${method}`);
}

function serve() {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      Promise.resolve(handle(msg)).catch((e) => process.stderr.write(`hproxy-mcp: ${e}\n`));
    }
  });
  process.stderr.write(`hproxy-mcp ${VERSION} ready on stdio (${BASE})\n`);
}

/* ---------------------------------------------------------------- */
/* The same three tools as a CLI                                     */
/* ---------------------------------------------------------------- */

const USAGE = `hproxy ${VERSION} — the free proxy tools, no key needed

  hproxy list [--country de] [--protocol socks5] [--anonymity elite] [--limit 25]
  hproxy check <ip:port> [ip:port ...]
  hproxy ip <address> [address ...]
  hproxy mcp                          run as an MCP server over stdio

Every command prints JSON. Docs: https://hproxy.com/tools/ai
`;

async function cli(argv) {
  const cmd = argv[0];
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 ? argv[i + 1] : fallback;
  };
  const rest = argv.slice(1).filter((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--"));

  if (cmd === "list") {
    return TOOLS.proxy_list.run({
      country: flag("country"),
      protocol: flag("protocol"),
      anonymity: flag("anonymity"),
      limit: Number(flag("limit", 25)),
    });
  }
  if (cmd === "check") return TOOLS.proxy_check.run({ proxies: rest });
  if (cmd === "ip") return TOOLS.ip_lookup.run({ ips: rest });
  return null;
}

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === "mcp") {
  serve();
} else if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
  process.stdout.write(USAGE);
} else if (argv[0] === "--version" || argv[0] === "-v") {
  process.stdout.write(VERSION + "\n");
} else {
  cli(argv)
    .then((out) => {
      if (out === null) {
        process.stderr.write(USAGE);
        process.exit(2);
      }
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    })
    .catch((e) => {
      process.stderr.write(`hproxy: ${e.message ?? e}\n`);
      process.exit(1);
    });
}
