# Working on this repository

Instructions for AI coding agents and people alike. To USE the tool from an
agent, read the README's "Command line" and "For AI assistants (MCP)" sections.

## Layout

| Path | What it is |
| --- | --- |
| `proxy-engine/hproxy-probe` | The engine: line parser, four timed transports, judge ladder, anonymity grading, HTTPS interception check, adaptive governor, batch runner. No UI, no database. |
| `proxy-engine/hproxy-relay` | The connector: a local HTTP and SOCKS5 proxy with no password that forwards through a real proxy with its login attached. Fixed line, rotating list, or the free pool. `routes.rs`: which sites use the proxy, a proxy in front of it, the login of the relay other devices use. |
| `proxy-engine/hproxy-system` | Read, set and restore the operating system's proxy setting. |
| `proxy-engine/hproxy-connection` | One connection for every door: the relay, the test before anything changes, the watching afterwards, what it decided (`Connection`, `verify.rs`, `health.rs`). |
| `proxy-engine/hproxy-api` | The client for hproxy.com's free doors: IP locations, API-mode checking, the free list. |
| `proxy-engine/hproxy-places` | The places a person keeps (saved proxies, groups, the pick), sealed in the app's own data folder, and what each one is: the targeting a provider puts in a username (country, region, city, session), read back. |
| `command-line-tool` | `hproxy`: check, connect, free, places, list, ip, and `mcp` (the MCP server). `src/places.rs` turns a saved place into the relay's source for every door, the desktop app's too. |
| `desktop-app/src-tauri` | The desktop app's Rust side: commands and events around the crates. |
| `src` | The desktop app's window (React, TypeScript, Tailwind). |
| `ios-app` | The iPhone app in SwiftUI. `Tunnel` is the process that holds a connection, `HProxy` the screens, `Shared` what both use, `Tests` the real engine under the Swift models. `project.yml` makes the Xcode project, which is never committed; `codemagic.yaml` builds and tests it, on rented Macs. Connecting cannot run on the Simulator. |

## The gate (CI runs exactly this)

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npx tsc --noEmit
npx vitest run
```

Live tests against our real judges are `#[ignore]`d; run them with
`cargo test -p hproxy-probe -- --ignored` when a change touches the ladder.

## This code is public

Everything in this repository, and every commit message, can be read by anyone.

- **No people in the code.** No names, no quotes from anyone, no "X picked this".
  A comment says what the code does and why, in the project's own voice.
- **No private places.** No paths on a maintainer's machine, no internal tool
  locations, no key locations, no server addresses of ours (tests use the
  documentation address space below).
- **No suppliers, no competitors by name** in code or docs. Research notes stay
  in the private repository, never here.
- **Commit messages follow the same rules**, since they are published with the code.

## Rules that keep the verdicts honest

- **One engine.** Every door (desktop, CLI, MCP) reads `hproxy-probe`. Never copy
  checking logic into a door; three copies that disagreed is how this project
  started.
- **A verdict change is measured on a fixed list, before and after.** Speed that
  hides false "dead" rows is a regression. A timeout never ends the ladder climb.
- **Library code never prints to stdout.** stdout belongs to the program: the MCP
  server speaks its protocol there, and `--json` output is parsed by machines.
  Words for people go to stderr, and only from `command-line-tool/` and `desktop-app/src-tauri`.
- **Passwords are never printed**, logged or returned in a machine answer that
  did not already contain them. `ProxyLine` and `Upstream` mask them in
  `Display`; use that.
- **Empty is not zero.** A field that was not measured stays empty; it is never
  filled with a guess. A dead row says why in plain words (`FailureDetail::sentence`).
- **Locations describe the exit.** A working row is located by `exit_ip`, never
  by the gateway it dialled.
- **"Connected" is earned.** Every door connects through `hproxy-connection`:
  traffic gets through the relay first (`verify.rs`), and only then does anything
  on the machine point at it. A switch tests on a trial relay and leaves the
  running one alone until the new place passed. Never show a connection on the
  strength of a listening port.
- **An error has a name.** Words for a failed connection start with the error,
  a colon, then what it means ("timed out: the proxy did not answer"): the
  engine writes them (`verify.rs`, `health.rs`), every window shows the name large
  and the rest under it, and the extension reads Chrome's codes into the same
  words (`chrome-extension/failure.js`). Say what happened, never just "failed".
- **The relay on this computer needs no password; the one for other devices always
  does.** `serve_network` asks for a login and only answers private addresses. Never
  widen either: an open relay is found and abused within minutes.
- **A rule never reaches the connection's own test.** `Routes::tested_at` keeps it on
  the proxy, or a dead proxy would pass through a site rule.
- **A notification goes through `desktop-app/src-tauri/src/notify.rs`.** The
  notification plugin signs with PowerShell's id when run from a build folder and
  with a wrong one in the Store copy; `notify.rs` signs with the real one.
- **Test a connection on a copy, never on the machine's real proxy.** Debug builds
  read `HPROXY_SYSTEM_FILE`: the setting then lives in that file instead of the
  operating system's, so a test window can go through every state without
  touching the browsers on the same computer. Release builds ignore it.
- **A new field on `CheckResult`** also goes into `command-line-tool/src/rows.rs` `FIELDS`
  (a test fails otherwise) and into `desktop-app/src/lib/checker.ts`.
- **Tests use documentation address space** (`192.0.2.0/24`, `198.51.100.0/24`,
  `203.0.113.0/24`, `2001:db8::/32`) and `example.com` / `.invalid` names, never
  real hosts, never our servers' addresses.
- **A running connection says so in one place.** Anything that serves a relay
  outside the desktop window (`connect --background`, the MCP server) publishes
  one file per process through `command-line-tool/src/connect.rs` and ends when its file
  is taken away. Never kill a process to stop a connection, never write a shared
  state file two processes edit, and never put a password in it. That file is
  the whole contract behind `hproxy status` and `hproxy stop`, and it is why a
  person can always see and end what an assistant opened on their machine.
  🪤 A missing entry means two opposite things: "not published yet" before the
  port opens, "somebody stopped us" after. Only the publisher can tell them
  apart, so it raises `Published` (`publish_and_mark`) and the watcher reads
  that flag. Waiting for the file to appear instead is a race: a `stop` that
  lands in the gap is then waited out forever.
- **The saved places are the app's.** The desktop app is the one program that
  writes the library (`hproxy-places`, in `store::app_dir`); the command line
  and the MCP server read it and never write it, so a connection started there
  counts no use and picks nothing. What leaves for a screen or a model is a
  view (names, addresses, targeting, the last check), never a line. A
  background copy is handed the place's NAME and reads it itself: a line in
  its arguments would put a password in the list of running processes.
- **A detached child must inherit nothing.** On Windows, handles are inherited
  per handle, not per stream, so a background copy is started only after
  `keep_our_streams_out_of_the_child` clears the inherit flag on this process's
  own streams. Without it, a caller reading our output through a pipe waits
  forever for an end that the long-lived child is holding open. A readiness
  signal therefore travels through the state file, never through a pipe.
