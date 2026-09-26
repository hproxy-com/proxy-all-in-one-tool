# hproxy-mcp

HProxy's free proxy tools, as tools your AI assistant can call. Also a CLI.

Three endpoints, no key, no account:

| Tool | What it does |
| --- | --- |
| `proxy_list` | Live free proxies from the public pool, re-checked around the clock. Filter by country, protocol and anonymity. |
| `proxy_check` | A real live test on any proxy: alive, protocols, anonymity, latency, location. Up to 25 per call. |
| `ip_lookup` | Any public IP: country, region, city, coordinates, timezone, ASN and the network behind it. |

Node 18 or newer. No dependencies.

## As an MCP server

**Claude Code**

```bash
claude mcp add hproxy -- npx -y hproxy-mcp
```

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hproxy": {
      "command": "npx",
      "args": ["-y", "hproxy-mcp"]
    }
  }
}
```

**Cursor** — `.cursor/mcp.json`, same shape. So do Windsurf, Cline and anything else that speaks MCP over stdio.

Then just ask: *"give me 20 elite German socks5 proxies and check which are alive"*.

## As a CLI

```bash
npx hproxy-mcp list --country de --protocol socks5 --limit 20
npx hproxy-mcp check 203.0.113.7:1080 198.51.100.3:8080
npx hproxy-mcp ip 8.8.8.8
```

Every command prints JSON, so it pipes into `jq` and into scripts.

## Without installing anything

The same three endpoints are plain HTTP, CORS enabled:

```bash
curl "https://hproxy.com/api/proxy-list?format=json&country=de&limit=20"
curl "https://hproxy.com/api/proxy-check?proxy=203.0.113.7:1080"
curl "https://hproxy.com/api/ip/8.8.8.8"
```

And the whole documentation is one markdown file an assistant can read:
<https://hproxy.com/llms.txt>

## Rate limits

The free endpoints are rate limited per IP rather than gated behind a key. A
`429` comes back with `Retry-After`; the server turns that into a plain message
so a model waits instead of hammering. The list is generous, the checker is
tighter because every check opens a real connection.

## What this is not

These are **free, public proxies**: shared, unpredictable, and fine for
testing, learning and one-off checks. Nothing here holds up under a real block.
For that, HProxy's paid pools are at <https://hproxy.com/pricing>.

## Development

```bash
node test.mjs     # speaks the protocol to the real server, calls every tool live
```

## Releasing

Updates are expected to be frequent, so the release is one command and the
tests are not optional: `prepublishOnly` runs the live suite, so a broken
build cannot reach npm.

```bash
npm run release:patch    # 1.0.0 -> 1.0.1, tests, then publish
npm run release:minor    # 1.0.0 -> 1.1.0, tests, then publish
```

Both run `npm version`, which also creates the git tag, then `npm publish`.
The first publish of all is a plain `npm publish` (there is nothing to bump
yet). You must be logged in: `npm whoami` should print the account that owns
the package.

Two things worth knowing before you ship:

- The test suite calls the **live** API. If hproxy.com is down the publish is
  blocked, which is deliberate. To override in an emergency:
  `npm publish --ignore-scripts`.
- `files` ships only `index.mjs` and this README. Check with `npm pack --dry-run`
  that nothing else crept in, because a tarball cannot be taken back: npm only
  allows unpublishing within 72 hours, and never if anything depends on it.

The install line printed on the site (`npx -y hproxy-mcp`) and in the
`AiToolBand` component assumes this exact package name, and that line now
appears on roughly half a million pages. If the name ever changes, those change
with it.

MIT.
