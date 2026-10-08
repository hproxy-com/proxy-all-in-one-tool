//! `hproxy mcp`: the checker and the connector as tools an AI assistant calls.
//!
//! Model Context Protocol over stdio: one JSON-RPC 2.0 message per line in,
//! one per line out. stdout carries the protocol and nothing else, ever; the
//! few words meant for a person go to stderr.
//!
//! The tools share their names with the `hproxy-mcp` npm server (which checks
//! from our servers), so one set of instructions works with either:
//! `proxy_check`, `proxy_list`, `ip_lookup`. On top, the four only a local
//! program can offer: `proxy_connect`, `proxy_status`, `proxy_new_ip`,
//! `proxy_disconnect`.
//!
//! Three rules shape every answer:
//!
//! 1. **A secret never enters the model's context unless the model put it
//!    there.** A proxy read from a file or from this server's environment
//!    (`HPROXY_PROXY`, `HPROXY_PROXY_FILE`) comes back with its password
//!    masked, and a file's lines are counted, never quoted. The relay is how
//!    an agent uses a proxy without ever holding its login.
//! 2. **Tokens cost money.** Working proxies are listed, fastest first; dead
//!    ones are counted by reason unless the model asks for them one by one.
//!    Empty fields are left out.
//! 3. **A failure is an answer.** A tool that fails returns `isError` with a
//!    sentence the model can act on, never a protocol error it cannot read.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hproxy_api::free_list::{self, ListQuery};
use hproxy_api::geo::Geo;
use hproxy_api::HttpClient;
use hproxy_probe::{Batch, CheckResult, Checker, ProtocolSet, Status};
use hproxy_relay::pool::Pool;
use hproxy_relay::upstream::{self, Scheme};
use hproxy_relay::{List, Rotation, Source, Stats};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::mpsc::UnboundedSender;

use crate::check::{self, batch_options, geo_client, Flow};
use crate::probe::tunnels_https;
use crate::rows::{self, Obj};
use crate::Outcome;

/// Most lines one call may check. Bigger lists belong to `hproxy check --file`,
/// which streams; an MCP answer arrives in one piece.
const MAX_LINES: usize = 10_000;
/// Most proxies listed one by one in an answer. The rest are counted.
const MAX_LISTED: usize = 200;
/// What a working row says in an answer, in this order.
const ANSWER_FIELDS: &[&str] = &[
    "input",
    "protocols",
    "anonymity",
    "latency_ms",
    "exit_ip",
    "rotating",
    "country_code",
    "city",
    "asn_org",
    "is_datacenter",
    "tls_intercepted",
];

const INSTRUCTIONS: &str = "hproxy checks proxies from this machine and connects through them. \
proxy_check tests proxy lines in any format and returns the working ones with exit address and location. \
proxy_list returns free proxies from hproxy.com; verify=true tests them here first. \
ip_lookup locates addresses. \
proxy_connect starts a local proxy on 127.0.0.1 (HTTP and SOCKS5 on one port, no password) that forwards through \
the chosen proxy with its login attached: point curl -x, a browser's --proxy-server, HTTP_PROXY/HTTPS_PROXY or \
Playwright at the returned http_proxy. A proxy set in this server's environment (HPROXY_PROXY) is used when \
proxy_connect gets no source, and its password never appears in an answer. Free proxies are public: never send \
logins or private data through them. app_open opens the HProxy desktop app for the person, or wakes it in the tray. \
A wrong tool name or argument is answered with the closest real one and every choice, so read the answer and call \
again.";

/// The relay this server is running, if any.
struct Link {
    local: SocketAddr,
    source: Arc<Source>,
    stats: Arc<Stats>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    started: Instant,
}

struct Server {
    checker: Arc<Checker>,
    geo: Arc<Geo>,
    http: HttpClient,
    link: tokio::sync::Mutex<Option<Link>>,
    /// Checks in flight by request id, so `notifications/cancelled` stops them.
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    out: UnboundedSender<String>,
}

pub async fn serve() -> Outcome {
    let (out, mut lines_out) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = lines_out.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err()
                || stdout.write_all(b"\n").await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });

    let server = Arc::new(Server {
        checker: Arc::new(Checker::public()),
        geo: Arc::new(geo_client()),
        http: hproxy_api::http_client("hproxy-mcp", Duration::from_secs(20)),
        link: tokio::sync::Mutex::new(None),
        running: Mutex::new(HashMap::new()),
        out,
    });
    eprintln!("hproxy {} MCP server on stdio", env!("CARGO_PKG_VERSION"));

    let mut input = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    loop {
        let line = match input.next_line().await {
            Ok(Some(l)) => l,
            // The client closed stdin: the session is over.
            Ok(None) | Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                server.reply_error(Value::Null, -32700, &format!("not JSON: {e}"));
                continue;
            }
        };
        let s = server.clone();
        // Every request runs on its own task, so a long check never holds up
        // a ping or a cancellation that arrives behind it.
        tokio::spawn(async move { s.handle(msg).await });
    }

    // Stop the relay with the session, then let the last answers drain.
    if let Some(mut link) = server.link.lock().await.take() {
        if let Some(stop) = link.stop.take() {
            let _ = stop.send(());
        }
    }
    drop(server);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    Outcome::Ok
}

impl Server {
    fn send(&self, v: Value) {
        let _ = self.out.send(v.to_string());
    }

    fn reply(&self, id: Value, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    fn reply_error(&self, id: Value, code: i32, message: &str) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}));
    }

    async fn handle(self: Arc<Self>, msg: Value) {
        if !msg.is_object() {
            self.reply_error(Value::Null, -32600, "send one JSON-RPC object per line");
            return;
        }
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        // A message without an id is a notification: it gets no answer.
        let Some(id) = msg.get("id").cloned() else {
            if method == "notifications/cancelled" {
                if let Some(req) = params.get("requestId") {
                    if let Some(flag) = self.running.lock().ok().and_then(|m| m.get(&req.to_string()).cloned()) {
                        flag.store(true, Ordering::SeqCst);
                    }
                }
            }
            return;
        };

        match method {
            "initialize" => {
                let version = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2025-06-18")
                    .to_string();
                self.reply(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": {"tools": {"listChanged": false}},
                        "serverInfo": {"name": "hproxy", "title": "HProxy", "version": env!("CARGO_PKG_VERSION")},
                        "instructions": INSTRUCTIONS,
                    }),
                );
            }
            "ping" => self.reply(id, json!({})),
            "tools/list" => self.reply(id, json!({ "tools": tools() })),
            "resources/list" => self.reply(id, json!({"resources": []})),
            "resources/templates/list" => self.reply(id, json!({"resourceTemplates": []})),
            "prompts/list" => self.reply(id, json!({"prompts": []})),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                // A wrong tool or a wrong argument is answered with the way out
                // before anything runs: the model reads it and corrects itself.
                if let Err(problem) = check_call(&name, &args) {
                    if tool_named(&name).is_none() {
                        self.reply_error(id, -32602, &problem);
                    } else {
                        self.reply(
                            id,
                            json!({"content": [{"type": "text", "text": problem}], "isError": true}),
                        );
                    }
                    return;
                }
                let outcome = match name.as_str() {
                    "proxy_check" => self.proxy_check(&args, &id).await,
                    "proxy_list" => self.proxy_list(&args, &id).await,
                    "ip_lookup" => self.ip_lookup(&args).await,
                    "proxy_connect" => self.proxy_connect(&args).await,
                    "proxy_status" => self.proxy_status(&args).await,
                    "proxy_new_ip" => self.proxy_new_ip().await,
                    "proxy_disconnect" => self.proxy_disconnect().await,
                    "app_open" => crate::app::open(args.get("background").and_then(Value::as_bool).unwrap_or(false)),
                    _ => {
                        self.reply_error(id, -32602, &format!("no tool named `{name}`"));
                        return;
                    }
                };
                let result = match outcome {
                    Ok(text) => json!({"content": [{"type": "text", "text": text}]}),
                    Err(text) => json!({"content": [{"type": "text", "text": text}], "isError": true}),
                };
                self.reply(id, result);
            }
            _ => self.reply_error(id, -32601, &format!("unknown method `{method}`")),
        }
    }

    /// Run a check under a cancel flag registered for this request.
    async fn run_check(
        &self,
        batch: Batch,
        first: Option<usize>,
        geo: bool,
        id: &Value,
    ) -> (hproxy_probe::Done, Vec<CheckResult>) {
        let key = id.to_string();
        if let Ok(mut m) = self.running.lock() {
            m.insert(key.clone(), batch.cancel_handle());
        }
        let mut rows: Vec<CheckResult> = Vec::new();
        let geo = geo.then(|| self.geo.clone());
        let (done, _) = check::run(batch, first, geo, |r| {
            rows.push(r);
            Flow::Continue
        })
        .await;
        if let Ok(mut m) = self.running.lock() {
            m.remove(&key);
        }
        (done, rows)
    }

    async fn proxy_check(&self, args: &Value, id: &Value) -> Result<String, String> {
        let file = arg_str(args, "file");
        let (lines, from_file) = match &file {
            Some(path) => (read_lines(path)?, true),
            None => (arg_strings(args, "proxies"), false),
        };
        if lines.is_empty() {
            return Err("give `proxies` (a list of proxy lines) or `file` (a path to a list)".into());
        }
        if lines.len() > MAX_LINES {
            return Err(format!(
                "{} lines is more than one call takes ({MAX_LINES}). Use `first`, split the list, or run `hproxy check --file` in a terminal.",
                lines.len()
            ));
        }
        let protocols = arg_protocols(args)?;
        let timeout = arg_seconds(args, "timeout_seconds", 8.0)?;
        let first = arg_count(args, "first")?.filter(|n| *n >= 1);
        let include_dead = arg_bool(args, "include_dead", false);
        let geo = arg_bool(args, "geo", true);

        let batch = Batch::new(
            lines,
            self.checker.clone(),
            batch_options(64, timeout, protocols, false, false, 0),
        );
        let (done, rows) = self.run_check(batch, first, geo, id).await;
        Ok(answer(&rows, &done, first, include_dead, from_file))
    }

    async fn proxy_list(&self, args: &Value, id: &Value) -> Result<String, String> {
        let limit = arg_count(args, "limit")?.filter(|n| *n >= 1).unwrap_or(25).min(200);
        let verify = arg_bool(args, "verify", false);
        let query = ListQuery {
            country: arg_str(args, "country"),
            protocol: arg_str(args, "protocol"),
            anonymity: arg_str(args, "anonymity"),
            // Verifying needs spare candidates: free proxies come and go, and
            // several on any page will not answer from here.
            limit: if verify {
                (limit * 4).min(free_list::MAX_LIMIT)
            } else {
                limit
            },
        };
        let found = free_list::fetch(&self.http, free_list::DEFAULT_LIST_API, &query).await?;
        if found.is_empty() {
            return Err("no free proxy matches those filters right now; loosen them or try again later".into());
        }
        if !verify {
            let items: Vec<String> = found
                .iter()
                .map(|p| serde_json::to_string(p).unwrap_or_default())
                .collect();
            return Ok(Obj::new()
                .put("count", found.len())
                .raw("proxies", &rows::array(&items))
                .put(
                    "note",
                    "public proxies, re-checked by hproxy.com; verify=true tests them from this machine",
                )
                .done());
        }
        let lines: Vec<String> = found.iter().map(|p| p.line()).collect();
        let protocols = match query.protocol.as_deref() {
            Some(p) => ProtocolSet::from_strings(&[p]),
            None => ProtocolSet::all(),
        };
        let batch = Batch::new(
            lines,
            self.checker.clone(),
            batch_options(64, Duration::from_secs(8), protocols, false, false, 0),
        );
        let (done, rows) = self.run_check(batch, Some(limit), true, id).await;
        Ok(answer(&rows, &done, Some(limit), false, false))
    }

    async fn ip_lookup(&self, args: &Value) -> Result<String, String> {
        let ips = arg_strings(args, "ips");
        self.geo.lookup(&ips).await.map(|v| v.to_string())
    }

    async fn proxy_connect(&self, args: &Value) -> Result<String, String> {
        let port = arg_count(args, "port")?.unwrap_or(0);
        if port > u16::MAX as usize {
            return Err("`port` must be 0 to 65535 (0 takes any free port)".into());
        }
        let addr = SocketAddr::from(([127, 0, 0, 1], port as u16));
        let source = build_source(args).await?;
        let kind = source.kind();

        // One relay at a time: connecting again replaces the old one.
        self.stop_link().await;

        let source = Arc::new(source);
        let stats = Arc::new(Stats::default());
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<SocketAddr>();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        // Raised below, once this link is written where `hproxy status` looks.
        let published = crate::connect::not_published_yet();
        let watched = published.clone();
        let task = tokio::spawn(hproxy_relay::serve(
            addr,
            false,
            false,
            source.clone(),
            stats.clone(),
            move |a| {
                let _ = ready_tx.send(a);
            },
            // Either the assistant lets go of it, or the person whose machine
            // this is runs `hproxy stop`, which takes our entry away.
            async move {
                tokio::select! {
                    _ = stop_rx => {}
                    _ = crate::connect::wait_until_stopped(std::process::id(), watched) => {}
                }
            },
        ));
        let local = match ready_rx.await {
            Ok(a) => a,
            // `serve` ended before it was listening: the bind failed.
            Err(_) => {
                return Err(match task.await {
                    Ok(Err(e)) => e,
                    _ => format!("could not listen on {addr}"),
                });
            }
        };
        *self.link.lock().await = Some(Link {
            local,
            source: source.clone(),
            stats,
            stop: Some(stop_tx),
            started: Instant::now(),
        });
        // Say so on the machine itself. A person who never sees this
        // conversation can then run `hproxy status` to find out that something
        // is listening for their assistant, and `hproxy stop` to end it.
        let _ = crate::connect::publish_and_mark(
            &crate::connect::Running {
                pid: std::process::id(),
                listening: local.to_string(),
                http_proxy: format!("http://{local}"),
                socks5_proxy: format!("socks5h://{local}"),
                upstream: source.in_use_now(),
                source: kind.name().to_string(),
                started_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs()),
            },
            &published,
        );

        let note = "no username or password needed on this address; the login is added on the way out";
        if !arg_bool(args, "verify", true) {
            return Ok(link_answer(local, &source.in_use_now(), kind, None)
                .put("note", note)
                .done());
        }
        let exit = self.verified_exit(local, &source).await;
        Ok(link_answer(local, &source.in_use_now(), kind, Some(&exit))
            .put("note", note)
            .done())
    }

    /// Probe through the relay; when that fails and the source can move on
    /// (a list, the free pool), move on and probe again, a few times. The agent
    /// gets a connection that works, or the reason none did, instead of an
    /// address that fails on its first request.
    async fn verified_exit(&self, local: SocketAddr, source: &Source) -> Result<CheckResult, String> {
        // Not good enough to hand an agent: no answer, no HTTPS (nearly every
        // site an agent visits is HTTPS, and a proxy that only relays plain
        // HTTP fails on the first one), or HTTPS through a proxy that re-signs
        // it and can read the agent's traffic.
        let unusable = |e: &Result<CheckResult, String>| match e {
            Ok(r) => !tunnels_https(r) || r.tls_intercepted == Some(true),
            Err(_) => true,
        };
        let mut exit = self.probe_exit(local).await;
        let mut tries = 0;
        while unusable(&exit) && source.can_rotate() && tries < 3 {
            tries += 1;
            if source.advance().await.is_err() {
                break;
            }
            exit = self.probe_exit(local).await;
        }
        exit
    }

    /// Is the link we think we have really gone? It can end without the
    /// assistant asking: the person whose machine this is runs `hproxy stop`,
    /// which takes our entry away and our relay shuts itself down. Reporting
    /// "connected" after that would send the model at a port with nothing
    /// behind it, which is the one answer worse than "not connected".
    fn link_is_over(local: SocketAddr) -> bool {
        crate::connect::asked_to_stop(std::process::id()) || !crate::connect::answers(&local.to_string())
    }

    async fn proxy_status(&self, args: &Value) -> Result<String, String> {
        let mut guard = self.link.lock().await;
        let mine = match guard.as_ref() {
            Some(link) if Self::link_is_over(link.local) => {
                // Ended under us. Let go of it, then answer as if we had none.
                *guard = None;
                None
            }
            Some(link) => Some((
                link.local,
                link.source.in_use_now(),
                link.source.kind(),
                link.stats.snapshot(),
                link.started.elapsed().as_secs(),
            )),
            None => None,
        };
        drop(guard);
        let Some((local, upstream, kind, stats, uptime)) = mine else {
            // Nothing of ours, which does not mean nothing at all: the person
            // may have started their own with `hproxy connect --background`.
            // Naming it stops the model concluding there is no proxy here, and
            // it can use it as it is. Ending it is the person's call, not ours.
            let others = tokio::task::spawn_blocking(crate::connect::running_now)
                .await
                .unwrap_or_default();
            let mut answer = Obj::new().put("connected", false);
            if let Some(r) = others.into_iter().next() {
                answer = answer.put(
                    "on_this_machine",
                    serde_json::json!({
                        "http_proxy": r.http_proxy,
                        "socks5_proxy": r.socks5_proxy,
                        "upstream": r.upstream,
                        "source": r.source,
                        "note": "started outside this conversation, usable as it is; leave stopping it to the person",
                    }),
                );
            }
            return Ok(answer.done());
        };
        let exit = if arg_bool(args, "probe", false) {
            Some(self.probe_exit(local).await)
        } else {
            None
        };
        Ok(link_answer(local, &upstream, kind, exit.as_ref())
            .put("uptime_seconds", uptime)
            .put("stats", stats)
            .done())
    }

    async fn proxy_new_ip(&self) -> Result<String, String> {
        let (local, source) = {
            let guard = self.link.lock().await;
            let link = guard.as_ref().ok_or("not connected; call proxy_connect first")?;
            (link.local, link.source.clone())
        };
        if !source.can_rotate() {
            return Err(
                "this is a single proxy with nothing to switch to. Rotating gateways change IP by their own rules \
                 (often a session in the username); a list (`file`) or the free pool can rotate here."
                    .into(),
            );
        }
        source.advance().await?;
        let exit = self.verified_exit(local, &source).await;
        Ok(link_answer(local, &source.in_use_now(), source.kind(), Some(&exit)).done())
    }

    async fn proxy_disconnect(&self) -> Result<String, String> {
        let was = self.stop_link().await;
        Ok(Obj::new()
            .put("connected", false)
            .put("stopped", was.map(|a| a.to_string()))
            .done())
    }

    async fn stop_link(&self) -> Option<SocketAddr> {
        let mut guard = self.link.lock().await;
        let mut link = guard.take()?;
        if let Some(stop) = link.stop.take() {
            let _ = stop.send(());
        }
        crate::connect::unpublish(std::process::id());
        Some(link.local)
    }

    /// Ask the judge THROUGH the relay who we are now: the exit address,
    /// where it is, how anonymous, how fast. Proves the whole path works.
    async fn probe_exit(&self, local: SocketAddr) -> Result<CheckResult, String> {
        crate::probe::exit_through(&self.checker, &self.geo, &local.to_string()).await
    }
}

/// The part of a connect, status or new-IP answer they all share. `exit` is
/// the probe through the relay, when one was made.
fn link_answer(
    local: SocketAddr,
    upstream: &str,
    kind: hproxy_relay::SourceKind,
    exit: Option<&Result<CheckResult, String>>,
) -> Obj {
    let o = Obj::new()
        .put("connected", true)
        .put("http_proxy", format!("http://{local}"))
        .put("socks5_proxy", format!("socks5h://{local}"))
        .put("upstream", upstream)
        .put("source", kind);
    let Some(exit) = exit else {
        return o;
    };
    match exit {
        Ok(r) => {
            let o = o
                .put("working", true)
                .put("https", tunnels_https(r))
                .put("exit_ip", &r.exit_ip)
                .put("country_code", &r.country_code)
                .put("city", &r.city)
                .put("asn_org", &r.asn_org)
                .put("anonymity", &r.anonymity)
                .put("latency_ms", r.latency_ms);
            if !tunnels_https(r) {
                o.put(
                    "warning",
                    "this proxy only relays plain HTTP: every HTTPS site will fail through it",
                )
            } else if r.tls_intercepted == Some(true) {
                o.put("tls_intercepted", true).put(
                    "warning",
                    "this proxy re-signs HTTPS with its own certificate: HTTPS clients will refuse it, and anything \
                     sent through it that trusts it can be read. Do not log in through it.",
                )
            } else {
                o
            }
        }
        Err(e) => o.put("working", false).put("problem", e),
    }
}

/// Where the relay's traffic goes: a line, a list file, the free pool, or
/// this server's environment.
async fn build_source(args: &Value) -> Result<Source, String> {
    let rotate = match arg_str(args, "rotate") {
        Some(r) => hproxy_relay::cli::parse_rotation(&r)?,
        None => Rotation::EveryConnection,
    };
    if arg_bool(args, "free", false) || arg_str(args, "free_country").is_some() {
        let country = arg_str(args, "free_country");
        let scheme = if arg_bool(args, "socks5", false) {
            Scheme::Socks5
        } else {
            Scheme::Http
        };
        let pool = Pool::new(country, scheme)?;
        let (source, _) = Source::from_pool(pool).await?;
        return Ok(source);
    }
    if let Some(line) = arg_str(args, "proxy") {
        return Ok(Source::Fixed(upstream::parse(&line)?));
    }
    if let Some(path) = arg_str(args, "file") {
        return list_source(&path, rotate);
    }
    // Nothing named: the proxy this server was started with, so its login
    // never has to pass through the conversation.
    if let Some(line) = std::env::var("HPROXY_PROXY").ok().filter(|s| !s.trim().is_empty()) {
        return Ok(Source::Fixed(upstream::parse(&line)?));
    }
    if let Some(path) = std::env::var("HPROXY_PROXY_FILE").ok().filter(|s| !s.trim().is_empty()) {
        return list_source(&path, rotate);
    }
    Err(
        "say which proxy: `proxy` (one line), `file` (a list), `free: true` (the free pool), \
         or start this server with HPROXY_PROXY set"
            .into(),
    )
}

fn list_source(path: &str, rotate: Rotation) -> Result<Source, String> {
    // The list's own lines are never quoted back: count only.
    let (members, _) = hproxy_relay::cli::read_list(path).map_err(|_| format!("{path} holds no usable proxy line"))?;
    Ok(Source::List(List::new(members, rotate)?))
}

/// A check's answer: the working proxies fastest first, the dead ones counted
/// by reason (or listed when asked), the unreadable lines counted.
fn answer(
    rows: &[CheckResult],
    done: &hproxy_probe::Done,
    first: Option<usize>,
    include_dead: bool,
    from_file: bool,
) -> String {
    let mut working: Vec<&CheckResult> = rows.iter().filter(|r| r.alive).collect();
    working.sort_by_key(|r| r.latency_ms.unwrap_or(i32::MAX));
    let fields: Vec<String> = ANSWER_FIELDS.iter().map(|f| f.to_string()).collect();
    let show = |r: &CheckResult| {
        let mut r = r.clone();
        if from_file {
            r.input = masked(&r.input);
        }
        rows::compact(&r, Some(&fields))
    };
    let listed: Vec<String> = working.iter().copied().take(MAX_LISTED).map(show).collect();

    let mut reasons: Vec<(String, usize)> = Vec::new();
    let mut unreadable = 0usize;
    let mut dead_rows: Vec<String> = Vec::new();
    for r in rows.iter().filter(|r| !r.alive) {
        if r.status == Status::Invalid {
            unreadable += 1;
            continue;
        }
        let word = match (r.status, r.failure) {
            (Status::Unresolved, _) => "unresolved".to_string(),
            (_, Some(f)) => f.as_str().to_string(),
            _ => "no_answer".to_string(),
        };
        match reasons.iter_mut().find(|(w, _)| *w == word) {
            Some((_, n)) => *n += 1,
            None => reasons.push((word.clone(), 1)),
        }
        if include_dead && dead_rows.len() < MAX_LISTED {
            dead_rows.push(
                Obj::new()
                    .put("input", if from_file { masked(&r.input) } else { r.input.clone() })
                    .put("failure", word)
                    .put("reason", &r.error)
                    .done(),
            );
        }
    }
    reasons.sort_by(|a, b| b.1.cmp(&a.1));
    let dead_counts = reasons
        .iter()
        .map(|(w, n)| format!("\"{w}\":{n}"))
        .collect::<Vec<_>>()
        .join(",");

    let mut o = Obj::new()
        .put("checked", done.total)
        .put("working", working.len())
        .put("seconds", (done.duration_ms as f64 / 100.0).round() / 10.0);
    if first.is_some_and(|n| working.len() >= n) {
        o = o.put("stopped_at_first", true);
    }
    o = o.raw("working_proxies", &rows::array(&listed));
    if working.len() > MAX_LISTED {
        o = o.put("more_working_not_listed", working.len() - MAX_LISTED);
    }
    if !reasons.is_empty() {
        o = o.raw("dead_by_reason", &format!("{{{dead_counts}}}"));
    }
    if include_dead {
        o = o.raw("dead_proxies", &rows::array(&dead_rows));
    }
    o.put("unreadable_lines", (unreadable > 0).then_some(unreadable))
        .put("duplicates_skipped", (done.duplicates > 0).then_some(done.duplicates))
        .done()
}

/// A line with its password replaced, for lines the model never saw.
fn masked(line: &str) -> String {
    match hproxy_probe::parse(line) {
        Ok(l) => l.to_string(),
        Err(_) => "(unreadable line)".into(),
    }
}

fn read_lines(path: &str) -> Result<Vec<String>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("could not read {path}: {}", e.kind()))?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect())
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn arg_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(default)
}

/// Lines from a list, or from one string with lines in it: models do both.
fn arg_strings(args: &Value, key: &str) -> Vec<String> {
    match args.get(key) {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .flat_map(str::lines)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        Some(Value::String(s)) => s
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// A whole number of at least 1, or absent. Accepts a number sent as text.
fn arg_count(args: &Value, key: &str) -> Result<Option<usize>, String> {
    let n = match args.get(key) {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    match n {
        Some(n) if n.is_finite() && n >= 0.0 && n.fract() == 0.0 => Ok(Some(n as usize)),
        _ => Err(format!("`{key}` must be a whole number")),
    }
}

fn arg_seconds(args: &Value, key: &str, default: f64) -> Result<Duration, String> {
    let s = match args.get(key) {
        None | Some(Value::Null) => default,
        Some(v) => v
            .as_f64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
            .filter(|s: &f64| s.is_finite())
            .ok_or(format!("`{key}` must be a number of seconds"))?,
    };
    Ok(Duration::from_secs_f64(s.clamp(1.0, 60.0)))
}

fn arg_protocols(args: &Value) -> Result<ProtocolSet, String> {
    let names = arg_strings(args, "protocols");
    if names.is_empty() {
        return Ok(ProtocolSet::all());
    }
    let set = ProtocolSet::from_strings(&names);
    if !set.any() {
        return Err("`protocols` takes http, https, socks4 and socks5".into());
    }
    Ok(set)
}

/// The tools, as `tools/list` describes them. Written for a model, and short:
/// every connected assistant carries this text in every conversation.
fn tools() -> Value {
    let read_only = json!({"readOnlyHint": true, "openWorldHint": true});
    let acts = json!({"readOnlyHint": false, "destructiveHint": false, "openWorldHint": true});
    json!([
        {
            "name": "proxy_check",
            "title": "Check proxies",
            "description": "Test proxies from this machine: works or not, protocols (http/https/socks4/socks5), anonymity, latency, exit IP with its country and network. Any line format (host:port, host:port:user:pass, user:pass@host:port, socks5://...). Returns working proxies fastest first; dead ones counted by reason. The only way to test proxies locked to this machine's IP.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "proxies": {"type": "array", "items": {"type": "string"}, "description": "Proxy lines, max 10000."},
                    "file": {"type": "string", "description": "Path to a list instead of proxies. Lines are never quoted back; passwords masked."},
                    "first": {"type": "integer", "minimum": 1, "description": "Stop once this many work."},
                    "protocols": {"type": "array", "items": {"type": "string", "enum": ["http", "https", "socks4", "socks5"]}, "description": "Default all four."},
                    "timeout_seconds": {"type": "number", "minimum": 1, "maximum": 60, "description": "Per attempt. Default 8."},
                    "include_dead": {"type": "boolean", "description": "List dead proxies with reasons instead of counts."},
                    "geo": {"type": "boolean", "description": "Exit country and network via hproxy.com, which gets exit IPs only. Default true."}
                }
            },
            "annotations": read_only
        },
        {
            "name": "proxy_list",
            "title": "Free proxies",
            "description": "Free public proxies from hproxy.com's live pool: protocols, anonymity, country, network, latency, uptime. verify=true tests them here and returns only working ones. Public proxies: never send logins or private data through them.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "country": {"type": "string", "description": "Two-letter code."},
                    "protocol": {"type": "string", "enum": ["http", "https", "socks4", "socks5"]},
                    "anonymity": {"type": "string", "enum": ["elite", "anonymous", "transparent"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200, "description": "Default 25."},
                    "verify": {"type": "boolean", "description": "Test here, return only working."}
                }
            },
            "annotations": read_only
        },
        {
            "name": "ip_lookup",
            "title": "IP lookup",
            "description": "Country, region, city, timezone, ASN and network of IP addresses, from hproxy.com.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ips": {"type": "array", "items": {"type": "string"}, "maxItems": 100}
                },
                "required": ["ips"]
            },
            "annotations": read_only
        },
        {
            "name": "proxy_connect",
            "title": "Connect through a proxy",
            "description": "Start a no-password HTTP and SOCKS5 proxy on 127.0.0.1 that forwards through a real proxy with its login added. Use the returned http_proxy with curl -x, --proxy-server, HTTP(S)_PROXY or Playwright. Source: proxy (one line), file (a list, see rotate), free=true (free pool), or none for this server's HPROXY_PROXY. Returns the verified exit IP and country, never the password. Calling again replaces the connection.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "proxy": {"type": "string"},
                    "file": {"type": "string", "description": "A list to rotate through."},
                    "rotate": {"type": "string", "description": "every (default), every:N, random, on-failure."},
                    "free": {"type": "boolean"},
                    "free_country": {"type": "string", "description": "Two-letter code."},
                    "socks5": {"type": "boolean", "description": "Free pool: SOCKS5 exits."},
                    "port": {"type": "integer", "minimum": 0, "maximum": 65535, "description": "Default 0: any free port."},
                    "verify": {"type": "boolean", "description": "Report the exit. Default true."}
                }
            },
            "annotations": acts
        },
        {
            "name": "proxy_status",
            "title": "Connection status",
            "description": "The local proxy: address, upstream (password masked), traffic; probe=true also checks the exit IP now.",
            "inputSchema": {"type": "object", "properties": {"probe": {"type": "boolean"}}},
            "annotations": read_only
        },
        {
            "name": "proxy_new_ip",
            "title": "New IP",
            "description": "Move the local proxy to the next list member or a fresh free exit; returns the new exit. One proxy line cannot rotate.",
            "inputSchema": {"type": "object", "properties": {}},
            "annotations": acts
        },
        {
            "name": "proxy_disconnect",
            "title": "Disconnect",
            "description": "Stop the local proxy.",
            "inputSchema": {"type": "object", "properties": {}},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true}
        },
        {
            "name": "app_open",
            "title": "Open the HProxy app",
            "description": "Open the HProxy desktop app's window for the person, or with background=true wake it in the tray without a window. Where only the standalone tool is installed, says so.",
            "inputSchema": {"type": "object", "properties": {"background": {"type": "boolean", "description": "Start it in the tray, no window."}}},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
        }
    ])
}

/// The tool with this name, from the list the server publishes.
fn tool_named(name: &str) -> Option<Value> {
    tools().as_array()?.iter().find(|t| t["name"] == name).cloned()
}

/// Is this a call the server can run? If not, why, in words a model acts on:
/// the closest real tool or argument, and every choice there is.
fn check_call(name: &str, args: &Value) -> Result<(), String> {
    let all = tools();
    let list = all.as_array().cloned().unwrap_or_default();
    let names: Vec<String> = list
        .iter()
        .filter_map(|t| t["name"].as_str().map(str::to_string))
        .collect();
    let Some(tool) = list.iter().find(|t| t["name"] == name) else {
        let mut s = format!("There is no tool named `{name}`.");
        if let Some(c) = crate::hint::closest(name, names.iter().map(String::as_str)) {
            s.push_str(&format!(" Did you mean `{c}`?"));
        }
        s.push_str(" The tools:");
        for t in &list {
            s.push_str(&format!(
                "\n- {}: {}",
                t["name"].as_str().unwrap_or(""),
                t["title"].as_str().unwrap_or("")
            ));
        }
        return Err(s);
    };
    let schema = &tool["inputSchema"];
    let props: Vec<String> = schema["properties"]
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let given = match args {
        Value::Object(o) => o,
        Value::Null => return Ok(()),
        _ => {
            return Err(format!(
                "The arguments of {name} are an object, e.g. {{\"{}\": ...}}.",
                props.first().map(String::as_str).unwrap_or("...")
            ))
        }
    };
    for key in given.keys() {
        if !props.iter().any(|p| p == key) {
            let mut s = format!("`{key}` is not an argument of {name}.");
            if let Some(c) = crate::hint::closest(key, props.iter().map(String::as_str)) {
                s.push_str(&format!(" Did you mean `{c}`?"));
            }
            if props.is_empty() {
                s.push_str(&format!(" {name} takes no arguments."));
            } else {
                s.push_str(&format!(" Its arguments: {}.", props.join(", ")));
            }
            return Err(s);
        }
    }
    for need in schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !given.contains_key(need) {
            return Err(format!("{name} needs `{need}`. Its arguments: {}.", props.join(", ")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hproxy_probe::Failure;

    #[test]
    fn a_wrong_tool_names_the_closest_and_lists_them_all() {
        let e = check_call("proxy_chek", &json!({})).unwrap_err();
        assert!(e.contains("Did you mean `proxy_check`?"), "{e}");
        for t in ["proxy_list", "ip_lookup", "proxy_connect", "proxy_disconnect"] {
            assert!(e.contains(t), "{t} missing from {e}");
        }
    }

    #[test]
    fn a_wrong_argument_names_the_closest_and_lists_them_all() {
        let e = check_call("proxy_list", &json!({"contry": "US"})).unwrap_err();
        assert!(e.contains("Did you mean `country`?"), "{e}");
        assert!(e.contains("protocol"), "{e}");
        let e = check_call("proxy_new_ip", &json!({"country": "DE"})).unwrap_err();
        assert!(e.contains("takes no arguments"), "{e}");
    }

    #[test]
    fn a_missing_required_argument_is_named() {
        let e = check_call("ip_lookup", &json!({})).unwrap_err();
        assert!(e.contains("needs `ips`"), "{e}");
    }

    #[test]
    fn a_right_call_passes() {
        assert!(check_call("proxy_list", &json!({"country": "US", "limit": 5})).is_ok());
        assert!(check_call("proxy_status", &Value::Null).is_ok());
        assert!(check_call("ip_lookup", &json!({"ips": ["8.8.8.8"]})).is_ok());
    }

    fn done(total: usize) -> hproxy_probe::Done {
        hproxy_probe::Done {
            total,
            alive: 0,
            duration_ms: 1234,
            cancelled: false,
            peak_concurrency: 16,
            duplicates: 0,
            invalid: 0,
        }
    }

    fn working(input: &str, ms: i32) -> CheckResult {
        CheckResult {
            input: input.into(),
            status: Status::Alive,
            alive: true,
            protocols: vec!["http".into()],
            latency_ms: Some(ms),
            exit_ip: Some("203.0.113.9".into()),
            ..Default::default()
        }
    }

    fn dead(input: &str, f: Failure) -> CheckResult {
        CheckResult {
            input: input.into(),
            status: Status::Dead,
            failure: Some(f),
            error: Some("no answer".into()),
            ..Default::default()
        }
    }

    #[test]
    fn an_answer_lists_working_fastest_first_and_counts_the_dead() {
        let rows = vec![
            working("198.51.100.1:80", 300),
            dead("198.51.100.2:80", Failure::Timeout),
            working("198.51.100.3:80", 90),
            dead("198.51.100.4:80", Failure::Timeout),
            dead("198.51.100.5:80", Failure::Refused),
            CheckResult::invalid("junk", "could not read"),
        ];
        let text = answer(&rows, &done(6), None, false, false);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["checked"], 6);
        assert_eq!(v["working"], 2);
        assert_eq!(v["working_proxies"][0]["input"], "198.51.100.3:80", "fastest first");
        assert_eq!(v["dead_by_reason"]["timeout"], 2);
        assert_eq!(v["dead_by_reason"]["refused"], 1);
        assert_eq!(v["unreadable_lines"], 1);
        assert!(
            v.get("dead_proxies").is_none(),
            "dead rows are counted unless asked for"
        );
        assert!(text.find("\"checked\"") < text.find("\"working_proxies\""), "{text}");
    }

    #[test]
    fn lines_from_a_file_never_come_back_with_their_password() {
        let rows = vec![working("198.51.100.1:8080:alice:hunter2", 50)];
        let text = answer(&rows, &done(1), None, true, true);
        assert!(!text.contains("hunter2"), "{text}");
        assert!(text.contains("alice"), "{text}");
        // From the model's own list the line is echoed as given.
        let text = answer(&rows, &done(1), None, false, false);
        assert!(text.contains("hunter2"));
    }

    #[test]
    fn arguments_are_read_the_way_models_send_them() {
        let args = json!({"proxies": ["1.2.3.4:80", "5.6.7.8:80\n9.9.9.9:80"], "first": "2", "timeout_seconds": 500});
        assert_eq!(
            arg_strings(&args, "proxies").len(),
            3,
            "a string with newlines is several lines"
        );
        assert_eq!(arg_count(&args, "first").unwrap(), Some(2), "a number sent as text");
        assert_eq!(
            arg_seconds(&args, "timeout_seconds", 8.0).unwrap(),
            Duration::from_secs(60)
        );
        assert!(arg_count(&json!({"first": 1.5}), "first").is_err());
        assert!(arg_count(&json!({"first": -1}), "first").is_err());
        assert!(arg_protocols(&json!({"protocols": ["ftp"]})).is_err());
        assert_eq!(arg_strings(&json!({"proxies": "a\nb"}), "proxies"), ["a", "b"]);
    }

    #[test]
    fn every_tool_has_a_name_a_description_and_a_schema() {
        let t = tools();
        let names: Vec<&str> = t
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "proxy_check",
                "proxy_list",
                "ip_lookup",
                "proxy_connect",
                "proxy_status",
                "proxy_new_ip",
                "proxy_disconnect",
                "app_open"
            ]
        );
        for tool in t.as_array().unwrap() {
            assert!(tool["description"].as_str().unwrap().len() > 20);
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
    }

    #[tokio::test]
    async fn a_connect_without_a_source_explains_what_to_give() {
        // The environment is empty for this key in tests.
        if std::env::var("HPROXY_PROXY").is_ok() || std::env::var("HPROXY_PROXY_FILE").is_ok() {
            return;
        }
        let e = build_source(&json!({})).await.err().unwrap();
        assert!(e.contains("HPROXY_PROXY") && e.contains("`proxy`"), "{e}");
        let e = build_source(&json!({"proxy": "not a proxy"})).await.err().unwrap();
        assert!(!e.is_empty());
    }
}
