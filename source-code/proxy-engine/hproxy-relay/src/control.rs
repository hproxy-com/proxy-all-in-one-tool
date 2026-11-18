//! The relay's own pages, for scripts in any language.
//!
//! An HTTP request is the one thing every language, shell and tool can make
//! without a library, so the relay answers a few itself, on its own port:
//!
//! ```text
//! GET  http://127.0.0.1:8080/hproxy/status            the proxy in use now, and the counts
//! POST http://127.0.0.1:8080/hproxy/new-ip            the next proxy (GET works too)
//! POST http://127.0.0.1:8080/hproxy/new-ip?member=3   proxy 3 of a list
//! GET  http://127.0.0.1:8080/hproxy                   every page, with what it does
//! ```
//!
//! Every answer is one line of JSON with `ok`, and `error` when `ok` is false.
//! A switch ends the connections that were open, the same as "Next IP" in the
//! app, so a program's next request goes out through the new proxy even over
//! a connection it kept alive.
//!
//! A request reaches the pages two ways: sent to the relay as to any web
//! server (`GET /hproxy/status`), or sent through it to its own address. The
//! second is what happens when HTTP_PROXY points at the relay and a script
//! calls `http://127.0.0.1:8080/hproxy/new-ip` without exempting it.
//!
//! The pages are as reachable as the relay. The relay other devices use asks
//! for its login here too: as `Authorization`, the way a page is logged in to
//! (`curl -u name:password`), or as `Proxy-Authorization`. A request a web
//! page makes is refused (browsers mark those), so a site someone visits can
//! neither switch their IP nor read which proxy they use.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::routes::Login;
use crate::source::SourceKind;
use crate::stats::{Stats, StatsSnapshot};
use crate::switchable::SwitchableSource;
use crate::upstream;

/// The path every page lives under.
pub const PREFIX: &str = "/hproxy";

/// Every page and what it does: the index's answer, and part of a 404's.
const PAGES: &[(&str, &str)] = &[
    ("/hproxy/status", "GET: the proxy in use now, and the counts"),
    (
        "/hproxy/new-ip",
        "POST or GET: switch to the next proxy. ?member=N switches to proxy N of a list",
    ),
];

/// What the pages read and change, shared by every connection of one relay.
pub struct Control {
    pub source: Arc<SwitchableSource>,
    pub started: Instant,
}

impl Control {
    pub fn new(source: Arc<SwitchableSource>) -> Self {
        Self {
            source,
            started: Instant::now(),
        }
    }
}

/// Where a script on this machine finds the pages of a relay listening on
/// `local`. A relay on every address (0.0.0.0, ::) is reached here through
/// loopback.
pub fn base_url(local: SocketAddr) -> String {
    let ip = match local.ip() {
        IpAddr::V4(v4) if v4.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(v6) if v6.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    format!("http://{}{PREFIX}", SocketAddr::new(ip, local.port()))
}

/// A request for one of the pages.
#[derive(Debug, PartialEq, Eq)]
pub struct Page {
    /// The page, lowercase: "" for the index, "status", "new-ip".
    pub name: String,
    /// What followed `?`, as it came.
    pub query: String,
}

/// The page a request line's target asks for, when it is one of ours.
///
/// `arrived_on` is the address the request came in on. A target in absolute
/// form (`http://127.0.0.1:8080/hproxy/status`, a request sent through the
/// relay as a proxy) is ours when it names this machine (`localhost`, a
/// loopback address or `arrived_on`'s address) and the port it came in on.
/// Any other site's `/hproxy/...` is that site's, and goes through the proxy.
pub fn page_of(target: &str, arrived_on: Option<SocketAddr>) -> Option<Page> {
    let path = if target.starts_with('/') {
        target.to_string()
    } else {
        let (host, port, path) = crate::relay::split_absolute_uri(target)?;
        let local = arrived_on?;
        if port != local.port() || !names_this_machine(&host, local.ip()) {
            return None;
        }
        path
    };
    let (path, query) = path.split_once('?').unwrap_or((path.as_str(), ""));
    let rest = strip_prefix_ignore_case(path, PREFIX)?;
    let name = match rest {
        "" | "/" => "",
        // `/hproxyfoo` is somebody else's path, and `/hproxy/status/` is ours.
        r => r.strip_prefix('/')?.trim_end_matches('/'),
    };
    Some(Page {
        name: name.to_ascii_lowercase(),
        query: query.to_string(),
    })
}

fn strip_prefix_ignore_case<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &s[prefix.len()..])
}

/// Whether `host`, from a request's target, is this machine: the name
/// `localhost`, a loopback address, or the address the request arrived on.
fn names_this_machine(host: &str, arrived_on: IpAddr) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .is_ok_and(|ip| ip.is_loopback() || ip.to_canonical() == arrived_on.to_canonical())
}

/// The value of header `name` in a request head, the first time it appears.
fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (n, v) = line.split_once(':')?;
        n.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

/// Why a browser's request is refused, when it is one.
///
/// A person typing a page's address into the address bar is welcome: the
/// browser marks that `Sec-Fetch-Site: none`. Anything a web page sends is
/// marked otherwise (or carries `Origin`, in browsers older than those marks),
/// and a page someone happens to visit has no business switching their IP or
/// reading which proxy they use. The check also stops a site that points a
/// name of its own at 127.0.0.1 (DNS rebinding): to the browser, that page's
/// requests are `same-origin`, which is refused here as well.
///
/// A prefetch is refused too: a browser fetching a typed address ahead of the
/// Enter key, which here would switch the IP before the person asked.
fn browser_refusal(head: &str) -> Option<&'static str> {
    if header(head, "sec-purpose").is_some()
        || header(head, "purpose").is_some_and(|v| v.eq_ignore_ascii_case("prefetch"))
    {
        return Some("a prefetch switches nothing. Press Enter to open the page");
    }
    let from_a_page = match header(head, "sec-fetch-site") {
        Some(site) => !site.eq_ignore_ascii_case("none"),
        None => header(head, "origin").is_some(),
    };
    from_a_page.then_some(
        "requests from web pages are refused, so a site you visit cannot switch your IP or read your proxy. \
         Call this page from a script or a terminal, or type its address into the address bar",
    )
}

/// Whether a request carries the relay's login, as a page's login
/// (`Authorization`) or a proxy's (`Proxy-Authorization`).
fn logged_in(head: &str, login: &Login) -> bool {
    let wanted = upstream::basic(&login.username, &login.password);
    head.lines().skip(1).any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            let name = name.trim();
            (name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("proxy-authorization"))
                && value.trim() == wanted
        })
    })
}

/// One answer: a status line, any extra headers, and its JSON.
#[derive(Debug)]
pub struct Reply {
    pub status: &'static str,
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
}

impl Reply {
    fn json(status: &'static str, body: &impl Serialize) -> Self {
        let mut text = serde_json::to_string(body).unwrap_or_else(|_| "{\"ok\":false}".into());
        text.push('\n');
        Reply {
            status,
            headers: Vec::new(),
            body: text,
        }
    }

    fn failed(status: &'static str, error: impl Into<String>) -> Self {
        Self::json(
            status,
            &Failed {
                ok: false,
                error: error.into(),
                pages: None,
            },
        )
    }

    fn with(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    /// The answer as it goes on the wire. `head_only` for a HEAD request.
    pub fn bytes(&self, head_only: bool) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
             Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n",
            self.status,
            self.body.len()
        );
        for (name, value) in &self.headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        out.push_str("\r\n");
        let mut bytes = out.into_bytes();
        if !head_only {
            bytes.extend_from_slice(self.body.as_bytes());
        }
        bytes
    }
}

/// The pages as one JSON object, in the order they are listed.
struct Pages;

impl Serialize for Pages {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_map(PAGES.iter().copied())
    }
}

#[derive(Serialize)]
struct Failed {
    ok: bool,
    error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pages: Option<Pages>,
}

#[derive(Serialize)]
struct Index {
    ok: bool,
    pages: Pages,
    version: &'static str,
}

/// What `/hproxy/status` says, and what a switch answers with.
#[derive(Serialize)]
struct Status {
    ok: bool,
    /// The proxy in use, as a person may see it: never the password.
    upstream: String,
    /// `fixed`, `list` or `pool`.
    source: SourceKind,
    /// For a list: the proxy in use, counted from 1 as its lines are.
    member: Option<usize>,
    /// For a list: how many proxies it has.
    members: Option<usize>,
    /// Whether `new-ip` has another proxy to switch to.
    can_rotate: bool,
    uptime_seconds: u64,
    stats: StatsSnapshot,
    version: &'static str,
}

fn status(control: &Control, stats: &Stats) -> Status {
    let source = control.source.current();
    let member = source.line_in_use().map(|line| line + 1);
    Status {
        ok: true,
        upstream: source.in_use_now(),
        source: source.kind(),
        member,
        members: member.and(source.size()),
        can_rotate: source.can_rotate(),
        uptime_seconds: control.started.elapsed().as_secs(),
        stats: stats.snapshot(),
        version: env!("CARGO_PKG_VERSION"),
    }
}

/// The answer to one request for a page. Nothing here touches the socket, so
/// tests call it directly.
pub async fn respond(
    head: &str,
    method: &str,
    page: &Page,
    login: Option<&Login>,
    stats: &Stats,
    control: &Control,
) -> Reply {
    if let Some(why) = browser_refusal(head) {
        return Reply::failed("403 Forbidden", why);
    }
    if login.is_some_and(|login| !logged_in(head, login)) {
        return Reply::failed(
            "401 Unauthorized",
            "this relay is for the devices on your network and asks for its login: send it as Basic \
             authorization, for example curl -u name:password",
        )
        .with("WWW-Authenticate", "Basic realm=\"HProxy\"");
    }
    let reads = method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD");
    let switches = method.eq_ignore_ascii_case("POST") || method.eq_ignore_ascii_case("GET");
    match page.name.as_str() {
        "" if reads => Reply::json(
            "200 OK",
            &Index {
                ok: true,
                pages: Pages,
                version: env!("CARGO_PKG_VERSION"),
            },
        ),
        "status" if reads => Reply::json("200 OK", &status(control, stats)),
        "" | "status" => not_allowed("GET, HEAD"),
        "new-ip" if switches => new_ip(&page.query, stats, control).await,
        "new-ip" => not_allowed("POST, GET"),
        other => Reply::json(
            "404 Not Found",
            &Failed {
                ok: false,
                error: format!("there is no page {PREFIX}/{other}"),
                pages: Some(Pages),
            },
        ),
    }
}

fn not_allowed(allow: &'static str) -> Reply {
    Reply::failed("405 Method Not Allowed", format!("this page answers {allow}")).with("Allow", allow)
}

/// Switch to the next proxy, or to `member=N` of a list, and answer with the
/// status after the switch.
///
/// A parameter it does not know is refused rather than skipped: `memebr=3`
/// passed over in silence would switch to the next proxy instead of the third,
/// and the script would never know.
async fn new_ip(query: &str, stats: &Stats, control: &Control) -> Reply {
    let mut member: Option<usize> = None;
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key {
            "member" => match value.parse::<usize>() {
                Ok(n) if n >= 1 => member = Some(n),
                _ => {
                    return Reply::failed(
                        "400 Bad Request",
                        "member counts from 1: member=1 is the first proxy of your list",
                    )
                }
            },
            other => {
                return Reply::failed(
                    "400 Bad Request",
                    format!("this page does not know `{other}`. It takes member=N, proxy N of your list"),
                )
            }
        }
    }
    let source = &control.source;
    let current = source.current();
    if let Some(n) = member {
        if current.kind() != SourceKind::List {
            return Reply::failed(
                "409 Conflict",
                "member picks a proxy of a list, and this relay goes through no list",
            );
        }
        return match source.go_to_line(n - 1) {
            Ok(_) => Reply::json("200 OK", &status(control, stats)),
            Err(e) => Reply::failed("400 Bad Request", e),
        };
    }
    if !current.can_rotate() {
        return Reply::failed(
            "409 Conflict",
            "this relay goes through one proxy, so there is no other to switch to. Rotating gateways change \
             IP by their own rules (often a session in the username). A list (--file) or the free pool \
             (--free) can rotate here",
        );
    }
    match source.next_ip().await {
        Ok(_) => Reply::json("200 OK", &status(control, stats)),
        Err(e) => Reply::failed("502 Bad Gateway", e),
    }
}

/// Answer a request for one of the pages, then close the connection.
///
/// `head` is the request's head as it came: its headers carry the login and
/// say whether a web page sent it.
pub async fn answer(
    client: &mut TcpStream,
    head: &[u8],
    method: &str,
    page: &Page,
    login: Option<&Login>,
    stats: &Stats,
    control: &Control,
) {
    let head = String::from_utf8_lossy(head);
    let reply = respond(&head, method, page, login, stats, control).await;
    let head_only = method.eq_ignore_ascii_case("HEAD");
    if client.write_all(&reply.bytes(head_only)).await.is_ok() {
        close_gently(client).await;
    }
}

/// Close after an answer without losing it. Closing a socket with bytes
/// still unread (a request body nobody needed) sends a reset, and a reset
/// can throw the answer away before the client has read it. So: say we are
/// done (FIN), read what is left until the client closes too, then go.
async fn close_gently(client: &mut TcpStream) {
    let _ = client.shutdown().await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let mut sink = [0u8; 4096];
    let mut left: usize = 64 * 1024;
    while left > 0 {
        match tokio::time::timeout_at(deadline, client.read(&mut sink)).await {
            Ok(Ok(n)) if n > 0 => left = left.saturating_sub(n),
            _ => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{List, Rotation, Source};

    fn here() -> Option<SocketAddr> {
        Some("127.0.0.1:8080".parse().unwrap())
    }

    fn page(name: &str, query: &str) -> Option<Page> {
        Some(Page {
            name: name.into(),
            query: query.into(),
        })
    }

    #[test]
    fn a_page_is_found_by_its_path_whatever_form_the_target_takes() {
        assert_eq!(page_of("/hproxy/status", here()), page("status", ""));
        assert_eq!(page_of("/hproxy/new-ip?member=3", here()), page("new-ip", "member=3"));
        assert_eq!(page_of("/HProxy/New-IP/", here()), page("new-ip", ""));
        assert_eq!(page_of("/hproxy", here()), page("", ""));
        assert_eq!(page_of("/hproxy/", here()), page("", ""));
        assert_eq!(page_of("/hproxy/nope", here()), page("nope", ""));
        // Not ours: another path on this port, and a name that only starts the same.
        assert_eq!(page_of("/", here()), None);
        assert_eq!(page_of("/favicon.ico", here()), None);
        assert_eq!(page_of("/hproxyfoo", here()), None);
    }

    #[test]
    fn sent_through_the_relay_to_itself_is_ours_and_another_sites_path_is_not() {
        // HTTP_PROXY set to the relay, and a script calling the relay's page.
        assert_eq!(
            page_of("http://127.0.0.1:8080/hproxy/status", here()),
            page("status", "")
        );
        assert_eq!(
            page_of("http://localhost:8080/hproxy/new-ip", here()),
            page("new-ip", "")
        );
        assert_eq!(page_of("http://[::1]:8080/hproxy/status", here()), page("status", ""));
        // On the network: the address the request came in on.
        let lan = Some("192.168.1.10:8080".parse().unwrap());
        assert_eq!(
            page_of("http://192.168.1.10:8080/hproxy/status", lan),
            page("status", "")
        );
        // Another port of this machine, and any other site: theirs.
        assert_eq!(page_of("http://127.0.0.1:9090/hproxy/status", here()), None);
        assert_eq!(page_of("http://example.com:8080/hproxy/status", here()), None);
        assert_eq!(page_of("http://192.168.1.11:8080/hproxy/status", lan), None);
        // Port 80 is the default when the target names none.
        assert_eq!(page_of("http://localhost/hproxy/status", here()), None);
        let on_80 = Some("127.0.0.1:80".parse().unwrap());
        assert_eq!(page_of("http://localhost/hproxy/status", on_80), page("status", ""));
    }

    #[test]
    fn the_address_scripts_use_never_names_every_address() {
        assert_eq!(
            base_url("127.0.0.1:8080".parse().unwrap()),
            "http://127.0.0.1:8080/hproxy"
        );
        assert_eq!(
            base_url("0.0.0.0:8080".parse().unwrap()),
            "http://127.0.0.1:8080/hproxy"
        );
        assert_eq!(base_url("[::]:9000".parse().unwrap()), "http://[::1]:9000/hproxy");
        assert_eq!(
            base_url("192.168.1.10:8080".parse().unwrap()),
            "http://192.168.1.10:8080/hproxy"
        );
    }

    #[test]
    fn a_web_page_is_refused_and_the_address_bar_is_welcome() {
        let req = |headers: &str| format!("GET /hproxy/new-ip HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n{headers}\r\n");
        // Scripts send none of these marks.
        assert!(browser_refusal(&req("User-Agent: curl/8.0\r\n")).is_none());
        // Node's fetch marks the mode, never the site: still a script.
        assert!(browser_refusal(&req("sec-fetch-mode: cors\r\n")).is_none());
        // Typed into the address bar.
        assert!(browser_refusal(&req("Sec-Fetch-Site: none\r\nSec-Fetch-Mode: navigate\r\n")).is_none());
        // Sent by a page: another site, a sister site, a name pointed at 127.0.0.1.
        for site in ["cross-site", "same-site", "same-origin"] {
            assert!(
                browser_refusal(&req(&format!("Sec-Fetch-Site: {site}\r\n"))).is_some(),
                "{site}"
            );
        }
        // An older browser, without the marks.
        assert!(browser_refusal(&req("Origin: https://example.com\r\n")).is_some());
        // A prefetch while the address is being typed.
        assert!(browser_refusal(&req("Sec-Fetch-Site: none\r\nSec-Purpose: prefetch\r\n")).is_some());
        assert!(browser_refusal(&req("Purpose: prefetch\r\n")).is_some());
    }

    #[test]
    fn the_login_counts_as_a_pages_login_or_a_proxys() {
        let login = Login {
            username: "name".into(),
            password: "secret".into(),
        };
        let basic = upstream::basic("name", "secret");
        let with = |h: &str| format!("GET /hproxy/status HTTP/1.1\r\n{h}: {basic}\r\n\r\n");
        assert!(logged_in(&with("Authorization"), &login));
        assert!(logged_in(&with("Proxy-Authorization"), &login));
        assert!(!logged_in(&with("X-Authorization"), &login));
        assert!(!logged_in("GET /hproxy/status HTTP/1.1\r\n\r\n", &login));
        let wrong = upstream::basic("name", "guess");
        assert!(!logged_in(
            &format!("GET / HTTP/1.1\r\nAuthorization: {wrong}\r\n\r\n"),
            &login
        ));
    }

    fn members(n: usize) -> Vec<crate::Upstream> {
        (0..n)
            .map(|i| upstream::parse(&format!("198.51.100.{}:8080:u:p", i + 1)).unwrap())
            .collect()
    }

    fn control_of(source: Source) -> Control {
        Control::new(Arc::new(SwitchableSource::new(source)))
    }

    const GET: &str = "GET /hproxy HTTP/1.1\r\n\r\n";

    async fn ask(control: &Control, method: &str, name: &str, query: &str) -> (String, serde_json::Value) {
        let page = Page {
            name: name.into(),
            query: query.into(),
        };
        let reply = respond(GET, method, &page, None, &Stats::default(), control).await;
        (reply.status.to_string(), serde_json::from_str(&reply.body).unwrap())
    }

    #[tokio::test]
    async fn status_and_new_ip_walk_a_list() {
        let list = List::new(members(3), Rotation::OnFailure).unwrap();
        let control = control_of(Source::List(list));

        let (code, s) = ask(&control, "GET", "status", "").await;
        assert_eq!(code, "200 OK");
        assert_eq!(s["ok"], true);
        assert_eq!(s["source"], "list");
        assert_eq!((s["member"].as_u64(), s["members"].as_u64()), (Some(1), Some(3)));
        assert_eq!(s["can_rotate"], true);
        assert_eq!(s["upstream"], "http://u:********@198.51.100.1:8080");
        assert!(!s.to_string().contains(":p@"), "never the password: {s}");

        let (code, s) = ask(&control, "POST", "new-ip", "").await;
        assert_eq!(code, "200 OK");
        assert_eq!(s["member"], 2);
        assert_eq!(s["upstream"], "http://u:********@198.51.100.2:8080");

        // A GET switches too: a browser's address bar, the shortest curl.
        let (_, s) = ask(&control, "GET", "new-ip", "").await;
        assert_eq!(s["member"], 3);

        // Straight to a member, and the status agrees afterwards.
        let (code, s) = ask(&control, "POST", "new-ip", "member=1").await;
        assert_eq!((code.as_str(), s["member"].as_u64()), ("200 OK", Some(1)));
        let (_, s) = ask(&control, "GET", "status", "").await;
        assert_eq!(s["member"], 1);
    }

    #[tokio::test]
    async fn what_cannot_be_done_says_why_with_the_right_code() {
        let list = List::new(members(2), Rotation::EveryConnection).unwrap();
        let control = control_of(Source::List(list));
        for (query, code) in [
            ("member=0", "400 Bad Request"),
            ("member=two", "400 Bad Request"),
            ("member=9", "400 Bad Request"),
            ("memebr=2", "400 Bad Request"),
        ] {
            let (got, s) = ask(&control, "POST", "new-ip", query).await;
            assert_eq!(got, code, "{query}");
            assert_eq!(s["ok"], false);
            assert!(s["error"].as_str().is_some_and(|e| !e.is_empty()), "{query}: {s}");
        }
        // Nothing moved on any of them.
        let (_, s) = ask(&control, "GET", "status", "").await;
        assert_eq!(s["member"], 1);

        // One proxy: nothing to switch to, and nothing to pick from.
        let fixed = control_of(Source::Fixed(upstream::parse("198.51.100.7:8080:u:p").unwrap()));
        let (code, s) = ask(&fixed, "POST", "new-ip", "").await;
        assert_eq!(code, "409 Conflict");
        assert!(s["error"].as_str().unwrap().contains("one proxy"), "{s}");
        let (code, _) = ask(&fixed, "POST", "new-ip", "member=2").await;
        assert_eq!(code, "409 Conflict");
        let (code, s) = ask(&fixed, "GET", "status", "").await;
        assert_eq!(code, "200 OK");
        assert_eq!((s["can_rotate"].as_bool(), s["member"].is_null()), (Some(false), true));

        // A wrong method, and a page that does not exist (which lists the real ones).
        let (code, _) = ask(&fixed, "DELETE", "new-ip", "").await;
        assert_eq!(code, "405 Method Not Allowed");
        let (code, _) = ask(&fixed, "POST", "status", "").await;
        assert_eq!(code, "405 Method Not Allowed");
        let (code, s) = ask(&fixed, "GET", "next", "").await;
        assert_eq!(code, "404 Not Found");
        assert!(s["pages"]["/hproxy/new-ip"].is_string(), "{s}");

        // The index lists every page.
        let (code, s) = ask(&fixed, "GET", "", "").await;
        assert_eq!(code, "200 OK");
        assert_eq!(s["pages"].as_object().map(|p| p.len()), Some(PAGES.len()));
    }

    #[tokio::test]
    async fn the_relay_for_other_devices_asks_for_its_login_and_a_page_gets_nothing() {
        let control = control_of(Source::Fixed(upstream::parse("198.51.100.7:8080").unwrap()));
        let login = Login {
            username: "name".into(),
            password: "secret".into(),
        };
        let page = Page {
            name: "status".into(),
            query: String::new(),
        };
        let stats = Stats::default();
        let reply = respond(GET, "GET", &page, Some(&login), &stats, &control).await;
        assert_eq!(reply.status, "401 Unauthorized");
        assert!(reply
            .headers
            .iter()
            .any(|(n, v)| *n == "WWW-Authenticate" && v.contains("Basic")));

        let head = format!(
            "GET /hproxy/status HTTP/1.1\r\nAuthorization: {}\r\n\r\n",
            upstream::basic("name", "secret")
        );
        let reply = respond(&head, "GET", &page, Some(&login), &stats, &control).await;
        assert_eq!(reply.status, "200 OK");

        let from_a_page = "GET /hproxy/status HTTP/1.1\r\nSec-Fetch-Site: cross-site\r\n\r\n";
        let reply = respond(from_a_page, "GET", &page, None, &stats, &control).await;
        assert_eq!(reply.status, "403 Forbidden");
    }

    #[test]
    fn a_head_request_gets_the_headers_alone() {
        let reply = Reply::failed("409 Conflict", "x");
        let full = String::from_utf8(reply.bytes(false)).unwrap();
        let head = String::from_utf8(reply.bytes(true)).unwrap();
        assert!(full.starts_with(&head) && full.len() > head.len());
        assert!(head.ends_with("\r\n\r\n"));
        assert!(head.contains(&format!("Content-Length: {}", reply.body.len())));
    }
}
