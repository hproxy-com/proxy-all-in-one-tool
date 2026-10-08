# What leaves your machine

This is a tool for privacy-sensitive work, so this page is exact. Everything
below is in the code; nothing is inferred from a policy.

**There is no account, no telemetry, no analytics, no crash reporting and no
tracking inside the app.** The app contacts HProxy, and for fraud scores
FFraud or the service whose key you give it. Every one of them is in the table
below, and each can be switched off or pointed elsewhere. Two of those requests
leave a record on our side, and only when you use the feature that sends them:
both are under "What our servers keep", with what they hold and for how long.

## Every server the app talks to

| When | Where | What is sent | Switch |
| --- | --- | --- | --- |
| Checking, "This computer" (the default, and always in the command-line tool) | Each proxy in your list, from your machine | The request the proxy has to relay: a probe to our judge. The proxy sees your address, as it would with any client. | Always on; it is the check |
| Checking, any mode | `hproxy.com/api/free-proxy/echo`, `echo.hproxy.com`, `hproxy.com/cdn-cgi/trace` (the judges) | A request THROUGH the proxy. The judge sees the proxy's address and the headers the proxy added, never your list. The certificate that comes back through an HTTPS tunnel is checked on your machine against the public root list; nothing is sent for that. | Settings, judge URLs |
| Checking, "Both" or "HProxy's servers" | `hproxy.com/api/free-proxy/check` | The proxies handed to our side, **credentials included**, because the checker needs the login to test the proxy. The proxies, their logins and your results are not stored server-side; a record of the request is (below, "What our servers keep"). | Settings, "This computer" |
| Location lookup | `hproxy.com/api/ip` | The IP addresses you check, in batches of 100. Not ports, not credentials, not results. | Settings, "Look up country, city and ISP" |
| Speed measurement (off by default) | `hproxy.com/api/free-proxy/speedtest` | A request THROUGH the proxy for a 64 KB payload. | Settings, "Measure download speed" |
| Connect, while connected | The server chosen under Settings, "Connect check": our judge by default, or Google, Cloudflare or any address you type | One request THROUGH the relay every twenty seconds: the round trip, and, from our judge or a Cloudflare trace page, the address you appear as. | Settings, "Connect check" |
| Connect, "Free proxy" | `hproxy.com/api/vpn/next`, `/api/vpn/report` | The country and protocol you asked for, the last exits you were given (so you get a different one), and a report when an exit stops answering. The report is kept (below, "What our servers keep"). | Only when you choose a free proxy |
| Fraud score, Connect (on by default) | `api.ffraud.com` (free, no key), or the service whose key you gave: IPQualityScore, Scamalytics, proxycheck.io or AbuseIPDB | The address you appear as, once for each new exit. Your key goes to its own service only. Nothing passes through HProxy, and nothing a service answers is kept past the session or sent anywhere. | Settings, "Fraud score" |
| Fraud score, Check (only when you ask) | The same | The exit address of each working proxy you ask about ("Fraud scores", or "Look it up" on a row). | Nothing is sent until you ask |
| Updates, the download for Windows, macOS or Linux (AppImage) | `hproxy.com/downloads/desktop/` | At start and every six hours: one list, the same for everyone, and the installer when there is a newer version. Downloads are signed and verified before they are installed. | Nothing is sent about you |
| Version check, every copy | `hproxy.com/downloads/versions.json` | At start and every six hours: one list, the same for everyone. The request names this copy's version and where it came from, for example `hproxy-checker/0.2.4 (windows)`, and nothing else. It is how a copy from a store or a downloaded package learns of a fix, and how we count how many copies run each version (kept 30 days, with the address shortened: "What our servers keep"). | Always on: it is how a fix reaches every copy |
| Updates, a copy from the Microsoft Store or Google Play | The store | The store's own update check, at start, under the store's own policy. | The store's settings |

To send **nothing at all**: keep checking on "This computer" ("This device" on
a phone), switch the location lookup off, do not use Connect, and do not ask
for fraud scores. Checking then works exactly the same, with the location
columns blank.

## What our servers keep

Everything in the table above is answered and forgotten, with two exceptions.
The location lookup keeps its answers in memory for a while, by the address
looked up, never by who asked; the judges keep nothing. These two requests
leave a row in our database:

| What | What the row holds | How long |
| --- | --- | --- |
| A check run on our servers ("Both" or "HProxy's servers") | The IP address the request came from, the app's user agent, how many proxies were sent and how long the check took. Never the proxies, their logins or the results. | 30 days, then deleted automatically |
| A report that a free exit stopped answering (Connect, "Free proxy") | The exit: its address, port and protocol, whether it answered and how fast. With it, the IP address the report came from, the country Cloudflare gives for that address, and the app's user agent. | No deletion date is set yet |

FFraud's free lookup (`api.ffraud.com/public/ip/`) counts how often each
looked-up address is asked about, never who asked; the address you ask from
is used only in memory, to limit how fast one address may ask. A service whose
key you gave keeps what its own policy says.

The update files are served without any record of who asked. The version
check (`hproxy.com/downloads/versions.json`) is logged, so we can count how
many copies run each version: the time, the network it came from, the request,
the answer's status, and the app's own line (`hproxy-checker/0.2.4 (windows)`).
The network is the address with its end cut off, the same shortening Google
Analytics uses (an IPv4 address loses its last part, 203.0.113.7 becomes
203.0.113.0; an IPv6 address keeps only its first three groups). The whole
address is never written. The log is kept 30 days, then deleted
(hproxy.com's server configuration, 2026-09-27).

(Checked against the code of hproxy.com and api.ffraud.com on 2026-09-24.)

## The command-line tool and its MCP server

`hproxy` never uses our checking servers: every check runs on the machine it
runs on. What it sends, and when:

| Command | Where | What is sent |
| --- | --- | --- |
| `hproxy check` | The proxies and the judges above | The same as the app's "This computer" mode. Nothing else. |
| `hproxy check --geo` | `hproxy.com/api/ip` | The exit address of each working proxy, in batches. Not ports, not credentials, not results. |
| `hproxy list` | `hproxy.com/api/proxy-list` | The filters you gave (country, protocol, grade, how many). |
| `hproxy ip` | `hproxy.com/api/ip` | The addresses you asked about. |
| `hproxy connect`, `hproxy free` | As Connect in the app | As above. |
| `hproxy mcp`, `proxy_check` | The proxies, the judges, and `hproxy.com/api/ip` | Exit addresses for their locations, unless the call says `geo: false`. |
| `hproxy mcp`, `proxy_list`, `ip_lookup` | `hproxy.com/api/proxy-list`, `hproxy.com/api/ip` | As `hproxy list` and `hproxy ip`. |
| `hproxy mcp`, `proxy_connect` | As Connect in the app | As above; a probe through the new connection to our judge, to report the exit. |
| Any command run at a terminal, once a day | `hproxy.com/downloads/versions.json` | `hproxy/0.2.4 (cli)`: the version and nothing else, to say in one line when a newer one is out. Never in a pipe, with `--json` or `--fields`, or for the MCP server; `HPROXY_NO_UPDATE_CHECK=1` turns it off. |

The MCP server puts no secret into the assistant's conversation that the
assistant did not send itself: a proxy taken from its environment
(`HPROXY_PROXY`, `HPROXY_PROXY_FILE`) or from a file comes back with its password
masked, and the lines of a file are counted, never quoted.

## What never leaves

- Your results. Not uploaded, not saved server-side, in any mode.
- Your saved proxies. They live in the app's own storage on your computer or
  phone, with their passwords, the way a proxy list in a text file on your
  desktop would. On a computer, anyone who can read your files can read them;
  on a phone, only the app can. The Android app is left out of the phone's
  backups and of the move to a new phone, so they do not travel that way
  either.
- Your settings, your run history, the per-network insights.
- Your API keys for fraud scores. They stay in the app's storage on your
  computer or phone, and each one goes only to its own service, with the
  lookup.
- Logs. The app writes a rotating log file in the operating system's log
  directory for bug reports. Proxy lines are never logged; addresses appear
  without their passwords.

## The relay

Connect runs a proxy on `127.0.0.1` with no password and forwards through the
proxy you chose, with the login attached. Only this machine can reach it: the
relay refuses to listen on any other address unless the command-line tool is
told to with `--allow-lan`, and the app never asks for that. The system proxy
setting, when you let the app set it, is put back exactly as found when you
disconnect, when the app exits any way at all, and on the next start after a
crash.

## The file that says a connection is running

A connection started with `--background`, and one an assistant opens through
`hproxy mcp`, writes a small file named after its own process in
`%LOCALAPPDATA%\hproxy\connections` (macOS: `~/Library/Application
Support/hproxy/connections`, elsewhere `$XDG_STATE_HOME/hproxy/connections` or
`~/.local/state/hproxy/connections`). It holds the local address, the source,
the masked upstream, the process number and when it started. **No password, no
list, no results.** It exists so `hproxy status` can show what is running on
this machine and `hproxy stop` can end it without killing processes, and it is
removed when the connection ends. Nothing in it is sent anywhere.

## The browser extension

The Chrome extension (`chrome-extension/`) sets Chrome's proxy to the one you
choose. Like the app, it has **no account, no telemetry, no analytics and no
tracking**, and it never sends a proxy's login to us.

| When | Where | What is sent | Switch |
| --- | --- | --- | --- |
| Opening the popup | `hproxy.com/api/vpn/countries` | Nothing about you: it asks for the list of countries with free exits. | Always |
| Before a connection, while nothing is connected | `hproxy.com/api/free-proxy/echo`, `echo.hproxy.com` | A plain request, so the extension learns the address your browser has without a proxy. It is kept for this browser session only, to tell whether traffic really goes through the proxy. | Only when you connect |
| Testing a proxy, yours or a free one | `probe.hproxy.com/api/free-proxy/echo`, THROUGH that proxy | One request per try. Our side sees the proxy's address, never your list or a login: a proxy's login goes only to that proxy. Your own proxy is tested in your browser, so a proxy locked to your address passes. (Until version 1.0 the line of a proxy you pasted, login included, was sent to our checker to learn its protocols; that call is gone.) | Only when you connect |
| Free proxies | `hproxy.com/api/vpn/pool`, `/api/vpn/report` | The country you picked; and, when a free exit stops answering, a report naming that exit (address, port, protocol). The report is kept ("What our servers keep"). | Only when you use a free proxy |
| The checks under "This connection", after you connect | The judges above, THROUGH the proxy; `hproxy.com/api/ip/` | Requests through the proxy, so the judges see the proxy's address and the headers it adds; and the exit's address, to show its country and network. | Only while connected |
| Updates | The Chrome Web Store | Chrome's own update check for its extensions; the extension asks Chrome to look at the browser's start. It sends us nothing for it. | Chrome's settings |

**On your computer, in the browser:** your saved proxies with their logins
(Chrome's local extension storage, which Chrome does not sync), the connection
in use, and the last place you connected to. Your favourite countries and
which tab opens first are synced by Chrome to your other browsers when you use
Chrome sync; they are country codes and a tab name, nothing else. Uninstalling
the extension deletes all of it.

**While connected** the extension locks WebRTC to the proxy, so a page cannot
reach around it and learn your real address; it is released when you
disconnect.

## Free proxies

The free exits are public proxies run by strangers. They are fine for seeing a
site from another country and wrong for anything with a login. Every exit is
proven to relay before you get it, and a dead one is swapped for a fresh one on
its own. Traffic through them is visible to whoever runs them, as with any
public proxy.

## The code

All of it is in this repository, MIT licensed. The engine (`proxy-engine/hproxy-probe`),
the relay (`proxy-engine/hproxy-relay`) and the system glue (`proxy-engine/hproxy-system`) are
ordinary Rust crates you can read and build yourself; the desktop app and the
command-line tool are thin layers on them.
