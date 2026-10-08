# HProxy

[![CI](https://github.com/hproxy-com/proxy-all-in-one-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/hproxy-com/proxy-all-in-one-tool/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**A free, open-source proxy checker and connector for Windows, macOS, Linux and
Android.** Paste a list of proxies and test every one on your own machine: live
status, protocol, speed, anonymity level, exit address, country and ISP. HTTP,
HTTPS, SOCKS4 and SOCKS5, all supported. Then connect through any of them, from
any program, with no password to type anywhere.

Fast and small (a ~5 MB installer and a ~3.5 MB command-line tool, not a 150 MB
Electron bundle), and gentle on your connection by design. No account, no
limits, nothing to sign up for. The same engine runs as a command-line tool for
scripts and as an MCP server for AI assistants.

> Built by [HProxy](https://hproxy.com). Need fresh, working proxies? Grab a
> free list at [hproxy.com/free-proxy-list](https://hproxy.com/free-proxy-list).

## What is in this repository

All of HProxy's software, in one place (Hproxy-Software-Bundle-Core):

| Folder | What it is |
| --- | --- |
| `desktop-app/` | The app for Windows, macOS and Linux, and the phone app (Android in `src-tauri/gen/android`, iOS generated on a Mac): check proxies, connect through them. |
| `command-line-tool/` | `hproxy`, the same engine on the command line, and `hproxy mcp`, its server for AI assistants. |
| `proxy-engine/` | What every door above shares: the checking engine, the connector (relay), the system proxy glue and the client for hproxy.com's free doors. |
| `chrome-extension/` | The browser extension: connect Chrome to your proxies, your HProxy plans or the free pool, with every free exit tested before your pages go through it. |
| `ai-tool-npm-package/` | The MCP server as an npm package (the same tools, calling hproxy.com's API). |

Installers built on a machine land in `finished-installers/`, which is never committed.

## Download

| Platform | Where | Notes |
| --- | --- | --- |
| Windows 10 and 11 | **[The installer on hproxy.com](https://hproxy.com/downloads/desktop/hproxy-windows-x64-setup.exe)**, or the **[Microsoft Store](https://apps.microsoft.com/detail/9NPDSV0K3J1X)** | The installer is not yet code-signed, so SmartScreen shows "Windows protected your PC" the first time. Click "More info", then "Run anyway". Updates after that come from hproxy.com and are checked by the app itself; the Store keeps its own copy up to date. |
| Android 7 and later | **[Google Play](https://play.google.com/store/apps/details?id=com.hproxy.app)** | The checker runs fully; Connect gives you the Wi-Fi proxy settings to type in, because a phone's proxy cannot be switched by an app. Google Play keeps it up to date. |
| macOS 12 and later (Apple Silicon and Intel) | not yet | Published once it is signed and notarized with Apple, so that it opens without a warning. |
| Linux (x86_64) | not yet | `.AppImage` and `.deb`, built by the same release pipeline as the other systems. |
| iOS | not yet | Needs an Apple developer account for a device build. The code compiles for iOS in CI. |
| Servers, scripts and AI agents | `curl -fsSL https://hproxy.com/install.sh \| sh` (macOS, Linux) or `irm https://hproxy.com/install.ps1 \| iex` (Windows) | The same engine and connector with no window: one file for every system and processor, checked against its SHA-256 before it is installed. The files are also on the **[Releases page](https://github.com/hproxy-com/proxy-all-in-one-tool/releases)**. See [Command line](#command-line) and [For AI assistants](#for-ai-assistants-mcp). |

## Features

- **All four protocols**: HTTP, HTTPS, SOCKS4 and SOCKS5, detected per line.
- **Live streaming results**: each proxy resolves the instant it answers, working
  ones rise to the top, dead ones sink.
- **Real detail per proxy**: status, protocol, latency, anonymity level
  (Elite / Anonymous / Transparent), country and city, ISP and ASN.
- **Catches proxies that read your HTTPS**: some proxies, free ones above all,
  answer HTTPS with a certificate of their own and can read everything that
  passes, passwords included. The checker verifies the certificate that comes
  back through every tunnel and flags those proxies instead of calling them
  merely "working". Never log in through one.
- **A timing breakdown, not one number**: DNS, TCP connect, proxy handshake, TLS
  and time to first byte, measured separately. A 900 ms proxy that spent 850 ms
  connecting is far away and will be quick for somebody nearer it; one that
  connected in 40 ms and then waited 830 ms is overloaded and will be slow for
  everybody. A single latency figure cannot tell those apart.
- **The exit address**: what the far end actually saw, flagged when it differs
  from the address you dialled, which is how you spot a rotating gateway or an
  onward chain. Country and network are those of the exit, not of the gateway.
- **The evidence, not just the verdict**: the exact headers a proxy added, with
  their values, and the proxy software behind it (Squid, MikroTik, HAProxy and
  the rest) read from `Via` rather than guessed.
- **Any format**: `host:port`, `host:port:user:pass`, `user:pass@host:port`,
  `user:pass:host:port`, `scheme://host:port`, CSV, spaces, IPv6. Paste it, drop
  a `.txt`, or import a file.
- **Export**: copy the working list, or save as `.txt`, `.csv` or `.json`.
- **Checks from your own machine by default**, which is the only way to test a
  proxy that is locked to your IP address. HProxy's servers can take part of the
  work when you choose it. See [Where checking runs](#where-checking-runs).
- **Gentle on your network, without guessing**: your concurrency setting is a
  ceiling rather than a target. The engine starts low and climbs while a direct
  connection to our own judge says your line has headroom, then backs off the
  moment it starts queueing. Additive increase, multiplicative decrease, the same
  shape TCP uses. Checkers that hardcode 350 threads are the reason people think
  proxy checking kills routers.
- **Connect from anywhere**: a proxy on `127.0.0.1` with no password, speaking
  HTTP and SOCKS5 on one port, that forwards through the proxy you chose with its
  login attached. See [Connect](#connect).
- **Fraud scores**: how risky sites will take an address to be, from FFraud's
  free lookup with no key, or from IPQualityScore, Scamalytics, proxycheck.io or
  AbuseIPDB with your own key. For every working proxy at once in Check, and
  for the address you appear as in Connect.
- **No account, no telemetry**: there is no signup, no analytics and no usage
  tracking of any kind. See [What leaves your machine](#what-leaves-your-machine).
- **Updates itself, safely**: the app checks at launch and every six hours,
  downloads a newer version in the background, and then offers it as a single
  "Restart to update" button in the title bar. While you use the app the
  restart is your click, and a running check is never cut short. While nobody
  does (the window closed to the tray, nothing connected, no check running) it
  installs the update itself, silently, and comes back in the tray. An AI
  assistant using HProxy keeps working through it (see For AI assistants). No
  dialogs, and nothing at all when you are up to date. Updates come from
  hproxy.com. Every one is cryptographically signed and verified before it is
  installed, and must have been signed after the build you have, so a
  compromised download host can neither push anything to you nor hand you an
  old version back.
- **No third-party services, at all**: anonymity is graded against our own judge
  and locations come from our own API. Most proxy checkers route your list
  through `httpbin.org`, `ip-api.com` or a handful of `azenv.php` pages on
  strangers' domains, which means somebody you have never heard of sees every
  proxy you test, and your grading silently breaks the day one of them starts
  redirecting. Nothing here talks to anyone but us, and the parts that talk to us
  are the parts you can switch off.

## How it works

The checking engine is native Rust. For each proxy it opens the four transports
at once, sends each one a request carrying a random value to a small "judge"
endpoint of ours, and counts the proxy as working only when the judge's answer
comes back with that value in it. A web server, a captive portal or a login
page that answers every request with a 200 cannot fake that. When the first
judge is out of reach the probe climbs to the next one.

Only a bounded number of proxies are ever checked at once, and the ceiling adapts
to your line, which is what keeps a big list from flooding your connection.

Country, city, ASN and ISP come from
[HProxy's free IP API](https://hproxy.com/docs/free/ip-lookup), which is keyless
and open for anyone to use. The lookup runs beside the check, so a label can
never delay a result.

We call an API rather than bundling a database on purpose: a city and ASN
database is 25 to 70 MB, which would make the download an order of magnitude
larger than this whole app, and MaxMind's GeoLite2 licence restricts
redistributing it anyway. The trade-off is that geolocation needs a connection.
If it is unavailable, checking still works and the location columns stay empty.

## Connect

The second screen. A proxy with no password runs on `127.0.0.1` and forwards
everything to the proxy you chose, login attached, so every program can use it,
including the ones with no login box and the operating systems that cannot speak
SOCKS5. The same port answers HTTP and SOCKS5, so it does not matter which kind
a program asks for. The line you type is checked for real before you connect.
Three sources: your own proxy, your own list rotated by a rule (every
connection, every N, random, or only when one dies), or a free exit from the
HProxy pool by country. While connected, a card shows the address the world sees
you from, the round trip, uptime and traffic, checked through the relay every
twenty seconds against our judge or any server you pick in Settings.
Disconnecting puts the system proxy setting back exactly as found.

A proxy that goes silent is given up on after 10 seconds without a connection
and 30 seconds without an answer, so a list or the free pool moves to the next
proxy quickly instead of waiting out the operating system's own two minutes.

## Command line

One file, no installer, no dependencies. Same engine, same verdicts.

```bash
hproxy check 198.51.100.7:8080 user:pass@203.0.113.9:1080   # a few lines
hproxy check --file proxies.txt                             # a table, row by row
hproxy check --file proxies.txt --json > rows.jsonl         # one JSON object per line
hproxy list --protocol socks5 | hproxy check --first 5 --alive   # 5 free SOCKS5 that work here
hproxy connect host:port:user:pass                          # 127.0.0.1:8080, no password
hproxy connect --file proxies.txt --rotate every:10 --listen 127.0.0.1:0 --json
hproxy free --country DE                                    # a free exit, swapped when it dies
hproxy ip 8.8.8.8                                           # where an address is
```

### Behind you

`--background` (or `-b`) starts the connection as a second copy with no console
window, prints where it listens, and returns. Nothing holds your terminal, and
closing the terminal leaves the connection running.

```bash
hproxy connect host:port:user:pass --background   # → {"listening":"127.0.0.1:8080", ...}
hproxy status                                     # everything running here, and what it uses
hproxy status --probe                             # and the address the world sees you as
hproxy stop                                       # end them all; `hproxy stop 8080` ends one
```

Several can run at once on different ports, so a browser can sit on one exit
while something else works through another. Each one writes a small file named
after its own process in `%LOCALAPPDATA%\hproxy\connections` (macOS:
`~/Library/Application Support/hproxy/connections`, elsewhere
`$XDG_STATE_HOME/hproxy/connections` or `~/.local/state/hproxy/connections`),
reads it back twice a second, and shuts itself down when the file is gone. That
file is what `hproxy status` lists and what `hproxy stop` removes: no process is
ever killed, nothing needs privileges, and a file wiped by a restart cleans up
after itself. It carries the address, the source and the masked upstream, never
a password. `HPROXY_STATE_DIR` moves the directory, which is what the tests use.

Built for scripts: rows go to stdout the moment they settle, words for people go
to stderr, `--json` leaves out empty fields, `--fields input,alive,latency_ms`
picks exactly the fields you want, `--first N` stops as soon as N proxies work,
and closing the pipe (`| head -1`) stops the run. `--geo` adds each exit's
country and network. `hproxy --help` lists everything.

Exit codes follow `grep`: **0** found what was asked for (at least one proxy
works), **1** ran fine and nothing works, **2** could not run (bad usage,
unreadable input, a service out of reach).

## For AI assistants (MCP)

`hproxy mcp` serves the checker and the connector to any assistant that speaks
the Model Context Protocol, over stdio, from the same single file. Tools:
`proxy_check`, `proxy_list`, `ip_lookup`, `proxy_connect`, `proxy_status`,
`proxy_new_ip`, `proxy_disconnect`, and `app_open`, which opens the desktop
app's window for the person or wakes it in the tray (`hproxy app` in a
terminal).

With the desktop app there is nothing to download: its Use with AI tab hands
the assistant a ready setup to copy and paste, nothing else. On Windows the app
keeps its own copy of itself outside the install folder (`hproxy.exe` in the
app's data folder) and puts that folder on your user PATH once, so the setup
simply says `hproxy`, the same on every computer; the uninstaller takes it off
the PATH again. An update's installer ends every running copy of the app's
program, and this copy is not one of them, so an update never waits for an
assistant and never ends its session. After an update the app puts the new
build in its place (a copy still running is renamed aside, which Windows
allows); the assistant gets it the next time it starts the tool. An assistant
that was already open when the app first ran needs one restart to find
`hproxy`.

```bash
claude mcp add hproxy -- hproxy mcp                      # Claude Code
```

```json
{ "mcpServers": { "hproxy": { "command": "hproxy", "args": ["mcp"] } } }
```

(the second form for Claude Desktop, Cursor, Windsurf and the rest.)

What makes it fit for an agent:

- **The password never enters the conversation.** Put the proxy in the server's
  own environment, `"env": { "HPROXY_PROXY": "host:port:user:pass" }` (or
  `HPROXY_PROXY_FILE` for a list), and `proxy_connect` with no arguments starts a
  local proxy that adds the login on the way out. The agent points curl,
  Playwright or a browser at `http://127.0.0.1:<port>` and never holds the
  secret. Answers mask passwords, and lines read from a file are counted, never
  quoted back.
- **Cheap in tokens.** A check answers with the working proxies, fastest first,
  and counts the dead ones by reason unless asked for them one by one. Empty
  fields are left out.
- **Verified, not assumed.** `proxy_connect` tests the new connection through
  itself before answering: it has to carry HTTPS, and a proxy that intercepts
  HTTPS does not count. A list or the free pool moves on to the next proxy until
  one passes.
- **Local.** Checks run from the machine the agent runs on, so a proxy locked to
  that machine's IP is judged correctly, and nothing is rate limited.
- **Out of the way, never out of reach.** The server runs headless, started by
  the client, so a connection it opens costs the person no window and blocks
  nothing they are doing. It is not hidden from them either: what the assistant
  opens is listed by `hproxy status` in any terminal, with the proxy masked, and
  `hproxy stop` ends it. The server notices within half a second and tells the
  model the connection is gone rather than pointing it at a dead port.

## Where checking runs

**Settings, Where checking runs** decides whose connection opens the thousands
of sockets a list needs. The default is **This computer**.

| Mode | What happens |
| --- | --- |
| **This computer** (default) | Every connection is opened from your machine. Nothing about your proxies is transmitted, every row has the full detail, and proxies locked to your IP address are judged correctly. |
| **Both at once** | The list is shared between HProxy's servers and your machine over one queue, so whichever side is quicker gets through more of it. Anything our servers cannot answer is re-checked locally, so nothing is dropped. |
| **HProxy's servers** | Everything runs on our hardware. Your machine makes one request and reads a stream. |

Why you might pick one of the other two: your own address is then not the one
connecting to every proxy in the list, your connection is not saturated by
thousands of simultaneous sockets, and a big run finishes sooner.

The trade-off is real and worth stating plainly. **Any mode that uses our
servers sends that part of your list to us, credentials included**, and our
server-side verifier returns less detail than the local engine: no timing
breakdown, no exit address, no leaked headers, no software detection. A proxy
that only accepts connections from your own IP address fails from our side.
Rows are labelled with which engine produced them so a mixed run is never
ambiguous.

## What leaves your machine

Being precise about this, since the whole tool is about privacy-sensitive work.
The full list of every server the app and the command-line tool talk to, when,
and with what, is in [PRIVACY.md](./PRIVACY.md). The short version:

| What | Where it goes |
| --- | --- |
| The proxy check itself | **Nowhere, by default**: your machine connects directly to each proxy. If you pick one of the modes that use our servers, the proxies handled by our side are sent to `hproxy.com/api/free-proxy/check`. The command-line tool always checks locally. |
| Proxy credentials (`user:pass`) | Same answer, and worth spelling out: a line sent to our checker carries its login, because the checker needs it to test the proxy. Checked locally, they go nowhere but the proxy itself. |
| Your results | Nowhere. Not uploaded, not saved server-side, in any mode. |
| The **IP addresses** you check | Sent to `hproxy.com/api/ip` to look up location and ASN, in batches. Nothing else about them is sent: not ports, not credentials, not results. The command-line tool only does this with `--geo`. |
| Anonymity grading | Your machine asks a "judge" endpoint, through the proxy, what it saw. That is how anonymity detection works in every proxy checker. |
| Fraud scores | Only the address being scored, from your machine straight to the service picked in Settings: `api.ffraud.com` by default (no key), or the one whose key you gave. In Check only when you ask; in Connect for the address you appear as, unless you turn it off. Your key goes to its own service only. |

To send **nothing at all**: keep checking on "This computer", turn
geolocation off in Settings, and do not ask for fraud scores. The location and
ISP columns go blank and everything else works exactly the same.

## Build from source

Prerequisites: [Rust](https://rustup.rs) and [Node.js](https://nodejs.org) 18+,
plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
cd desktop-app
npm install
npm run tauri dev     # run the app in development
npm run tauri build   # produce an installer for your platform
cd ..
cargo build --release -p hproxy-cli   # the command-line tool: target/release/hproxy
```

Android needs the Android SDK and NDK (`ANDROID_HOME`, `NDK_HOME`) and Java 17;
then, in `desktop-app`, `npm run tauri android build --apk`. The release build
signs with the keystore named in `desktop-app/src-tauri/gen/android/keystore.properties`,
which is not in the repository; without it the APK is unsigned. iOS needs a Mac
with Xcode: in `desktop-app`, `npm run tauri ios init`, then `npm run tauri ios build`.

## Tech stack

- **[Tauri 2](https://tauri.app)**: a small, fast, native desktop shell.
- **Rust**: the checking engine (`proxy-engine/hproxy-probe`), the connector
  (`proxy-engine/hproxy-relay`), the system proxy glue (`proxy-engine/hproxy-system`) and the
  client for our public API (`proxy-engine/hproxy-api`), built on `tokio`, `rustls`
  and `tokio-socks`.
- **React, TypeScript and Tailwind CSS**: the interface.

## License

[MIT](./LICENSE) © HProxy
