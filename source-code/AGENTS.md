# Working on this repository

Instructions for AI coding agents and people alike. To USE the tool from an
agent, read the README's "Command line" and "For AI assistants (MCP)" sections.

## Layout

| Path | What it is |
| --- | --- |
| `proxy-engine/hproxy-probe` | The engine: line parser, four timed transports, judge ladder, anonymity grading, HTTPS interception check, adaptive governor, batch runner. No UI, no database. |
| `proxy-engine/hproxy-relay` | The connector: a local HTTP and SOCKS5 proxy with no password that forwards through a real proxy with its login attached. Fixed line, rotating list, or the free pool. |
| `proxy-engine/hproxy-system` | Read, set and restore the operating system's proxy setting. |
| `proxy-engine/hproxy-api` | The client for hproxy.com's free doors: IP locations, API-mode checking, the free list. |
| `command-line-tool` | `hproxy`: check, connect, free, list, ip, and `mcp` (the MCP server). |
| `desktop-app/src-tauri` | The desktop app's Rust side: commands and events around the crates. |
| `src` | The desktop app's window (React, TypeScript, Tailwind). |

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
- **A detached child must inherit nothing.** On Windows, handles are inherited
  per handle, not per stream, so a background copy is started only after
  `keep_our_streams_out_of_the_child` clears the inherit flag on this process's
  own streams. Without it, a caller reading our output through a pipe waits
  forever for an end that the long-lived child is holding open. A readiness
  signal therefore travels through the state file, never through a pipe.
