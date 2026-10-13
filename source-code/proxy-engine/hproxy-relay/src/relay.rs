//! The relay itself.
//!
//! A client on this machine speaks ordinary HTTP-proxy to us with no password.
//! We speak to the real proxy with the password attached. Nothing else changes:
//! we never read a response body, never touch TLS, and never see inside a
//! tunnel. This is deliberately a plumbing job rather than an HTTP stack.
//!
//! TWO PATHS, because an HTTP proxy has two modes:
//!
//!   CONNECT  Used for every https:// URL, which today is nearly all traffic.
//!            After the upstream says 200 the connection is an opaque tunnel
//!            carrying TLS, so we copy bytes in both directions and stay out of
//!            it. This path is where the interesting work is.
//!
//!   Absolute-URI  Used for plain http:// URLs. The request line carries the
//!            whole URL. We rewrite the headers (drop any hop-by-hop ones, add
//!            ours) and stream the rest.
//!
//! ⚠️ WE FORCE `Connection: close` ON THE PLAIN PATH. With keep-alive, a single
//! connection carries several requests back to back, and every one of them needs
//! the auth header, which means finding each message boundary, which means
//! parsing Content-Length and chunked encoding correctly. Getting that subtly
//! wrong corrupts a request body. Closing after one request costs a handshake on
//! the rare plain-HTTP request and cannot corrupt anything.
//!
//! The same port also speaks SOCKS5, told apart by the first byte (a SOCKS5
//! greeting starts with 5, an HTTP request with a letter). Plenty of software
//! takes only a SOCKS proxy: Java's `socksProxyHost`, many game launchers and
//! chat clients. One address that answers both means nobody has to know which
//! kind their program wants.

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::stats::{Counted, Stats};
use crate::switchable::Ticket;
use crate::upstream::{self, Scheme, Upstream};

/// Cap on a request head. Real ones are a couple of KB; anything past this is a
/// client that will never send `\r\n\r\n`, and without a cap that is unbounded
/// memory per connection.
const MAX_HEAD: usize = 64 * 1024;

/// How long a client may take to say what it wants. Browsers open spare
/// connections to a proxy ahead of need and may leave them silent; closing one
/// after a minute costs the browser nothing, keeping it forever costs a socket.
const CLIENT_IDLE: Duration = Duration::from_secs(60);

/// How long the upstream proxy has to accept the TCP connection. Without a
/// limit, a proxy that is down but silently drops packets holds every request
/// for the operating system's own limit, about 21 s on Windows and about two
/// minutes on Linux, and failover to the next proxy waits all of that.
const UPSTREAM_CONNECT: Duration = Duration::from_secs(10);

/// How long the whole dial may take once connecting is included: the CONNECT
/// or SOCKS5 exchange, during which the upstream itself reaches the target. A
/// proxy that accepts the connection and then says nothing is dead too.
const UPSTREAM_DIAL: Duration = Duration::from_secs(30);

/// How long a SOCKS5 greeting may wait for its answer when SOCKS5 is the
/// second guess. A SOCKS5 server answers the greeting at once,
/// before it reaches anything; an HTTP proxy that got those bytes instead may
/// sit waiting for a line ending that never comes, and that wait must not eat
/// the dial's whole budget.
const SECOND_GUESS_GREETING: Duration = Duration::from_secs(4);

/// The upstream answered, but not in the protocol we spoke to it: the line's
/// prefix was wrong, or it had none and the proxy is SOCKS5. The one failure
/// worth a second try in the other protocol.
#[derive(Debug)]
struct WrongProtocol(String);

impl std::fmt::Display for WrongProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WrongProtocol {}

fn wrong_protocol(why: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, WrongProtocol(why.into()))
}

fn is_wrong_protocol(e: &io::Error) -> bool {
    e.get_ref().is_some_and(|inner| inner.is::<WrongProtocol>())
}

/// How a plain http:// request reached its server: through the HTTP proxy
/// itself (absolute URI, our login attached), or through a tunnel straight to
/// the origin (origin-form request, no proxy login).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Leg {
    Proxy,
    Origin,
}

/// Read up to and including the blank line that ends the request head.
///
/// Returns the head and whatever arrived after it, which on the plain path is
/// the first bytes of the request body and must not be dropped.
async fn read_head(s: &mut TcpStream) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(i) = find_head_end(&buf) {
            let rest = buf.split_off(i);
            return Ok((buf, rest));
        }
        if buf.len() > MAX_HEAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request head too large"));
        }
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "client closed before finishing its request",
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn find_head_end(b: &[u8]) -> Option<usize> {
    b.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// Split `host:port`, tolerating `[::1]:443`.
fn split_target(t: &str) -> Option<(String, u16)> {
    if let Some(rest) = t.strip_prefix('[') {
        let (h, after) = rest.split_once(']')?;
        return Some((h.to_string(), after.strip_prefix(':')?.parse().ok()?));
    }
    let (h, p) = t.rsplit_once(':')?;
    Some((h.to_string(), p.parse().ok()?))
}

/// Pull host, port and origin-form path out of an absolute request URI.
fn split_absolute_uri(uri: &str) -> Option<(String, u16, String)> {
    let (default_port, rest) = match uri.split_once("://") {
        Some(("http", r)) => (80u16, r),
        Some(("https", r)) => (443, r),
        _ => return None,
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    // Credentials embedded in the target URI are not ours to forward.
    let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
    let (host, port) = match split_target(authority) {
        Some(hp) => hp,
        None => (
            authority.trim_matches(|c| c == '[' || c == ']').to_string(),
            default_port,
        ),
    };
    Some((host, port, path.to_string()))
}

/// Headers that describe THIS hop and must never be passed along. Ours replaces
/// any `Proxy-Authorization` the client invented, and `Proxy-Connection` is a
/// non-standard header that confuses some upstreams.
fn is_dropped_header(line: &[u8]) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.starts_with(b"proxy-authorization:")
        || lower.starts_with(b"proxy-connection:")
        || lower.starts_with(b"connection:")
        || lower.starts_with(b"keep-alive:")
}

/// Rebuild a request head for the upstream: same request line, hop-by-hop
/// headers removed, our credentials and `Connection: close` added.
fn rewrite_head(head: &[u8], request_line: &str, auth: Option<&str>) -> Vec<u8> {
    let mut out = Vec::with_capacity(head.len() + 128);
    out.extend_from_slice(request_line.as_bytes());
    out.extend_from_slice(b"\r\n");
    for line in head.split(|b| *b == b'\n').skip(1) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() || is_dropped_header(line) {
            continue;
        }
        out.extend_from_slice(line);
        out.extend_from_slice(b"\r\n");
    }
    if let Some(a) = auth {
        out.extend_from_slice(b"Proxy-Authorization: ");
        out.extend_from_slice(a.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"Connection: close\r\n\r\n");
    out
}

/// Connect to the upstream proxy itself, within `limit`.
async fn connect_upstream(up: &Upstream, limit: Duration) -> io::Result<TcpStream> {
    match tokio::time::timeout(limit, TcpStream::connect(up.addr())).await {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(e)) => Err(io::Error::new(
            e.kind(),
            format!("could not reach the proxy at {}: {e}", up.addr()),
        )),
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("the proxy at {} did not answer within {} s", up.addr(), limit.as_secs()),
        )),
    }
}

/// Open a TCP connection to `host:port` THROUGH the upstream proxy.
async fn dial_through(up: &Upstream, host: &str, port: u16) -> io::Result<TcpStream> {
    dial_through_within(up, host, port, UPSTREAM_CONNECT, UPSTREAM_DIAL).await
}

/// One dial in one protocol. `greeting` caps the wait for a SOCKS5 greeting's
/// answer (when SOCKS5 is the second guess); `None` leaves it to the total.
async fn dial_as(
    scheme: Scheme,
    up: &Upstream,
    host: &str,
    port: u16,
    connect: Duration,
    greeting: Option<Duration>,
) -> io::Result<TcpStream> {
    match scheme {
        Scheme::Http => http_connect(up, host, port, connect).await,
        Scheme::Socks5 => socks5_connect(up, host, port, connect, greeting).await,
    }
}

/// `dial_through` with its two limits as parameters, so a test can use short ones.
///
/// A line's prefix is only a guess at what the proxy speaks: scraped lists are
/// full of bare SOCKS5 proxies (no prefix means HTTP) and of wrong prefixes.
/// So the first try is what the address is known to speak, else the line's
/// word; if the proxy answers in the other protocol, that one is tried once,
/// and whichever worked is remembered so later connections go straight to it.
async fn dial_through_within(
    up: &Upstream,
    host: &str,
    port: u16,
    connect: Duration,
    total: Duration,
) -> io::Result<TcpStream> {
    let dial = async {
        let first = upstream::first_try(up);
        match dial_as(first, up, host, port, connect, None).await {
            Ok(s) => {
                upstream::remember(up, first);
                Ok(s)
            }
            Err(e) if is_wrong_protocol(&e) => {
                let second = first.other();
                match dial_as(second, up, host, port, connect, Some(SECOND_GUESS_GREETING)).await {
                    Ok(s) => {
                        upstream::remember(up, second);
                        Ok(s)
                    }
                    // The first answer describes what the line was taken to be;
                    // the second only says the other guess failed too.
                    Err(_) => Err(e),
                }
            }
            Err(e) => Err(e),
        }
    };
    match tokio::time::timeout(total, dial).await {
        Ok(r) => r,
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!(
                "the proxy at {} accepted the connection but did not open the way to {host}:{port} within {} s",
                up.addr(),
                total.as_secs()
            ),
        )),
    }
}

/// Read an upstream's answer up to the blank line that ends its head. Bytes
/// after the head are dropped: nothing may arrive in a fresh tunnel before the
/// client speaks.
///
/// An answer that is not HTTP at all, or a connection closed before a single
/// byte, is [`WrongProtocol`]: the proxy speaks something else. A SOCKS5
/// server reads the C of `CONNECT` as its version byte and hangs up at once.
async fn read_reply_head(s: &mut TcpStream) -> io::Result<Vec<u8>> {
    const HTTP: &[u8] = b"HTTP/";
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 2048];
    loop {
        if let Some(i) = find_head_end(&buf) {
            buf.truncate(i);
            return Ok(buf);
        }
        // Still HTTP as long as what arrived could begin "HTTP/".
        let could_be_http = HTTP.starts_with(&buf[..buf.len().min(HTTP.len())]);
        if !could_be_http {
            return Err(wrong_protocol("the proxy answered, but not in HTTP"));
        }
        if buf.len() > MAX_HEAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the proxy's answer is too large",
            ));
        }
        let n = match s.read(&mut chunk).await {
            Ok(n) => n,
            Err(e)
                if buf.is_empty()
                    && matches!(
                        e.kind(),
                        io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
                    ) =>
            {
                return Err(wrong_protocol("the proxy hung up without an HTTP answer"));
            }
            Err(e) => return Err(e),
        };
        if n == 0 {
            if buf.is_empty() {
                return Err(wrong_protocol("the proxy closed the connection without an HTTP answer"));
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the proxy closed the connection in the middle of its answer",
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// CONNECT against an HTTP upstream.
async fn http_connect(up: &Upstream, host: &str, port: u16, connect: Duration) -> io::Result<TcpStream> {
    let mut s = connect_upstream(up, connect).await?;
    let target = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some(a) = up.basic_header() {
        req.push_str(&format!("Proxy-Authorization: {a}\r\n"));
    }
    req.push_str("Proxy-Connection: Keep-Alive\r\n\r\n");
    s.write_all(req.as_bytes()).await?;

    let head = read_reply_head(&mut s).await?;
    let status = std::str::from_utf8(&head)
        .ok()
        .and_then(|h| h.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .unwrap_or(0);
    if (200..300).contains(&status) {
        Ok(s)
    } else {
        Err(io::Error::other(format!("upstream refused CONNECT: {status}")))
    }
}

/// SOCKS5 (RFC 1928) with optional username/password auth (RFC 1929).
///
/// Worth having for its own sake: the Windows system proxy setting cannot speak
/// SOCKS5 at all, so pointing it at this connector is the only way a lot of
/// Windows software reaches a SOCKS5 proxy.
async fn socks5_connect(
    up: &Upstream,
    host: &str,
    port: u16,
    connect: Duration,
    greeting: Option<Duration>,
) -> io::Result<TcpStream> {
    let mut s = connect_upstream(up, connect).await?;

    // Greeting: offer exactly what we can actually do.
    if up.auth.is_some() {
        s.write_all(&[0x05, 0x02, 0x00, 0x02]).await?;
    } else {
        s.write_all(&[0x05, 0x01, 0x00]).await?;
    }
    let mut m = [0u8; 2];
    let answered = match greeting {
        Some(limit) => match tokio::time::timeout(limit, s.read_exact(&mut m)).await {
            Ok(r) => r,
            Err(_) => return Err(wrong_protocol("no SOCKS5 answer to the greeting")),
        },
        None => s.read_exact(&mut m).await,
    };
    match answered {
        Ok(_) => {}
        // Hung up on the greeting without a word: not a SOCKS5 server.
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {
            return Err(wrong_protocol(
                "the proxy closed the connection without a SOCKS5 answer",
            ))
        }
        Err(e) => return Err(e),
    }
    if m[0] != 0x05 {
        return Err(wrong_protocol("upstream is not a SOCKS5 proxy"));
    }
    match m[1] {
        0x00 => {}
        0x02 => {
            let (u, p) = up
                .auth
                .as_ref()
                .ok_or_else(|| io::Error::other("upstream wants a login and none was given"))?;
            if u.len() > 255 || p.len() > 255 {
                return Err(io::Error::other("SOCKS5 username or password over 255 bytes"));
            }
            let mut auth = vec![0x01, u.len() as u8];
            auth.extend_from_slice(u.as_bytes());
            auth.push(p.len() as u8);
            auth.extend_from_slice(p.as_bytes());
            s.write_all(&auth).await?;
            let mut r = [0u8; 2];
            s.read_exact(&mut r).await?;
            if r[1] != 0x00 {
                return Err(io::Error::other(
                    "SOCKS5 login rejected: check the username and password",
                ));
            }
        }
        0xff => {
            return Err(io::Error::other(
                "SOCKS5 upstream rejected every login method we offered",
            ))
        }
        other => return Err(io::Error::other(format!("SOCKS5 method {other} unsupported"))),
    }

    // CONNECT. Send the hostname rather than resolving it here, so DNS happens
    // at the exit (this is what socks5h:// means, and it is what you want from a
    // proxy: resolving locally leaks the lookup and can pick the wrong region).
    let mut req = vec![0x05, 0x01, 0x00];
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => {
            req.push(0x01);
            req.extend_from_slice(&v4.octets());
        }
        Ok(std::net::IpAddr::V6(v6)) => {
            req.push(0x04);
            req.extend_from_slice(&v6.octets());
        }
        Err(_) => {
            if host.len() > 255 {
                return Err(io::Error::other("hostname longer than SOCKS5 allows"));
            }
            req.push(0x03);
            req.push(host.len() as u8);
            req.extend_from_slice(host.as_bytes());
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await?;

    let mut head = [0u8; 4];
    s.read_exact(&mut head).await?;
    if head[1] != 0x00 {
        return Err(io::Error::other(format!(
            "SOCKS5 upstream refused the connection: {}",
            socks_reply(head[1])
        )));
    }
    // Consume the bound address so the stream is positioned at the payload.
    match head[3] {
        0x01 => {
            let mut skip = [0u8; 6];
            s.read_exact(&mut skip).await?;
        }
        0x04 => {
            let mut skip = [0u8; 18];
            s.read_exact(&mut skip).await?;
        }
        0x03 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len).await?;
            let mut skip = vec![0u8; len[0] as usize + 2];
            s.read_exact(&mut skip).await?;
        }
        other => return Err(io::Error::other(format!("SOCKS5 address type {other} unknown"))),
    }
    Ok(s)
}

fn socks_reply(code: u8) -> &'static str {
    match code {
        0x01 => "general failure",
        0x02 => "not allowed by ruleset",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown error",
    }
}

/// Carry bytes both ways until either side closes, or until the turn this
/// connection belongs to ends (a switch of place, "Next IP", the relay
/// stopping). Ended, both sockets close and the program opens a new
/// connection, which goes through whatever the relay uses now.
async fn carry<S>(client: &mut TcpStream, server: &mut S, ticket: &mut Ticket)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    tokio::select! {
        _ = tokio::io::copy_bidirectional(client, server) => {}
        _ = ticket.ended() => {}
    }
}

/// A short HTTP error the browser will actually display.
async fn reply_error(s: &mut TcpStream, status: &str, detail: &str) {
    let body = format!("HProxy Connector: {detail}\n");
    let msg = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = s.write_all(msg.as_bytes()).await;
}

/// What a SOCKS5 client asked for.
#[derive(Debug, PartialEq, Eq)]
enum Socks5Request {
    Connect {
        host: String,
        port: u16,
    },
    /// BIND or UDP ASSOCIATE, which this relay does not offer.
    Unsupported(u8),
}

/// A SOCKS5 reply. The bound address is left as 0.0.0.0:0, which every client
/// accepts for CONNECT.
fn socks5_reply(code: u8) -> [u8; 10] {
    [0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
}

/// Read a SOCKS5 client's greeting, its login if it insists on one, and its
/// request (RFC 1928, RFC 1929).
///
/// No login is needed on this side: the relay listens on loopback and adds the
/// real login upstream. A client that offers only username and password is
/// accepted and its words ignored, because some programs always send the
/// fields they were configured with, even empty ones.
async fn socks5_read_request<S>(s: &mut S) -> io::Result<Socks5Request>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut greeting = [0u8; 2];
    s.read_exact(&mut greeting).await?;
    if greeting[0] != 0x05 {
        return Err(io::Error::other("not a SOCKS5 greeting"));
    }
    let mut methods = vec![0u8; greeting[1] as usize];
    s.read_exact(&mut methods).await?;
    if methods.contains(&0x00) {
        s.write_all(&[0x05, 0x00]).await?;
    } else if methods.contains(&0x02) {
        s.write_all(&[0x05, 0x02]).await?;
        let mut ver_ulen = [0u8; 2];
        s.read_exact(&mut ver_ulen).await?;
        let mut user = vec![0u8; ver_ulen[1] as usize];
        s.read_exact(&mut user).await?;
        let mut plen = [0u8; 1];
        s.read_exact(&mut plen).await?;
        let mut pass = vec![0u8; plen[0] as usize];
        s.read_exact(&mut pass).await?;
        s.write_all(&[0x01, 0x00]).await?;
    } else {
        s.write_all(&[0x05, 0xff]).await?;
        return Err(io::Error::other(
            "the client offered no login method this relay accepts",
        ));
    }

    let mut req = [0u8; 4];
    s.read_exact(&mut req).await?;
    if req[0] != 0x05 {
        return Err(io::Error::other("not a SOCKS5 request"));
    }
    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await?;
            Ipv4Addr::from(a).to_string()
        }
        0x04 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await?;
            Ipv6Addr::from(a).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            s.read_exact(&mut name).await?;
            String::from_utf8(name).map_err(|_| io::Error::other("the hostname is not text"))?
        }
        other => {
            let _ = s.write_all(&socks5_reply(0x08)).await;
            return Err(io::Error::other(format!("SOCKS5 address type {other} unknown")));
        }
    };
    let mut port = [0u8; 2];
    s.read_exact(&mut port).await?;
    if req[1] != 0x01 {
        return Ok(Socks5Request::Unsupported(req[1]));
    }
    Ok(Socks5Request::Connect {
        host,
        port: u16::from_be_bytes(port),
    })
}

/// Serve a client that spoke SOCKS5 to us: read its request, dial the target
/// through the upstream exactly as a CONNECT would, then relay bytes.
async fn socks5_client(mut client: TcpStream, ticket: &mut Ticket, verbose: bool, stats: &Arc<Stats>) {
    let src = Arc::clone(&ticket.source);
    let request = match tokio::time::timeout(CLIENT_IDLE, socks5_read_request(&mut client)).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            if verbose {
                eprintln!("  socks5 client: {e}");
            }
            return;
        }
        Err(_) => return,
    };
    let (host, port) = match request {
        Socks5Request::Connect { host, port } => (host, port),
        Socks5Request::Unsupported(cmd) => {
            let _ = client.write_all(&socks5_reply(0x07)).await;
            if verbose {
                eprintln!("  socks5 command {cmd} is not supported, only CONNECT");
            }
            return;
        }
    };
    if verbose {
        eprintln!("  SOCKS5 {host}:{port}");
    }
    let dialed = src
        .dial_with_failover(|up| {
            let h = host.clone();
            async move { dial_through(&up, &h, port).await }
        })
        .await;
    let mut server = match dialed {
        Ok(d) => {
            if d.rotated {
                stats.rotated();
            }
            Counted::new(d.stream, Arc::clone(stats))
        }
        Err(e) => {
            stats.failed();
            let code = match e.kind() {
                io::ErrorKind::ConnectionRefused => 0x05,
                io::ErrorKind::TimedOut => 0x04,
                _ => 0x01,
            };
            let _ = client.write_all(&socks5_reply(code)).await;
            if verbose {
                eprintln!("  upstream: {e}");
            }
            return;
        }
    };
    if client.write_all(&socks5_reply(0x00)).await.is_err() {
        return;
    }
    carry(&mut client, &mut server, ticket).await;
}

/// Serve one client connection start to finish.
///
/// Takes the connection's [`Ticket`] rather than an `Upstream`: its `Source`
/// decides failover (a free-pool exit can die between one request and the
/// next, and the right answer there is to rotate rather than to fail), and its
/// turn says when a switch or "Next IP" ends this connection. This file only
/// has to ask.
///
/// `stats` counts this connection, its failure if it cannot reach the proxy,
/// and every byte that crosses the proxy side of it.
pub async fn handle(mut client: TcpStream, mut ticket: Ticket, verbose: bool, stats: &Arc<Stats>) {
    let _open = stats.opened();
    let src = Arc::clone(&ticket.source);

    // One port, two protocols. A SOCKS5 greeting starts with the byte 5; an
    // HTTP request starts with its method's first letter.
    let mut first_byte = [0u8; 1];
    match tokio::time::timeout(CLIENT_IDLE, client.peek(&mut first_byte)).await {
        Ok(Ok(1)) if first_byte[0] == 0x05 => {
            socks5_client(client, &mut ticket, verbose, stats).await;
            return;
        }
        Ok(Ok(n)) if n > 0 => {}
        // Closed, broken, or silent for a minute: nothing to serve.
        _ => return,
    }

    let (head, leftover) = match tokio::time::timeout(CLIENT_IDLE, read_head(&mut client)).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            if verbose {
                eprintln!("  client: {e}");
            }
            return;
        }
        Err(_) => return,
    };

    let first = String::from_utf8_lossy(&head).lines().next().unwrap_or("").to_string();
    let mut it = first.split_whitespace();
    let (method, uri) = (it.next().unwrap_or(""), it.next().unwrap_or(""));

    if method.eq_ignore_ascii_case("CONNECT") {
        let Some((host, port)) = split_target(uri) else {
            reply_error(
                &mut client,
                "400 Bad Request",
                &format!("could not read `{uri}` as host:port"),
            )
            .await;
            return;
        };
        if verbose {
            eprintln!("  CONNECT {host}:{port}");
        }
        let dialed = src
            .dial_with_failover(|up| {
                let h = host.clone();
                async move { dial_through(&up, &h, port).await }
            })
            .await;
        let mut server = match dialed {
            Ok(d) => {
                if d.rotated {
                    stats.rotated();
                }
                Counted::new(d.stream, Arc::clone(stats))
            }
            Err(e) => {
                // 502 rather than a silent drop: a browser showing "the proxy
                // refused the connection" is a debuggable symptom, a hang is not.
                stats.failed();
                reply_error(&mut client, "502 Bad Gateway", &e.to_string()).await;
                if verbose {
                    eprintln!("  upstream: {e}");
                }
                return;
            }
        };
        if client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .is_err()
        {
            return;
        }
        if !leftover.is_empty() && server.write_all(&leftover).await.is_err() {
            return;
        }
        carry(&mut client, &mut server, &mut ticket).await;
        return;
    }

    // Plain HTTP: the request line carries an absolute URI.
    let Some((host, port, path)) = split_absolute_uri(uri) else {
        reply_error(
            &mut client,
            "400 Bad Request",
            "this port expects proxy requests. Point your software's PROXY setting here rather than opening it as a web page.",
        )
        .await;
        return;
    };
    if verbose {
        eprintln!("  {method} {host}:{port}{path}");
    }

    /* ⚠️ The plain path does NOT tunnel.
    An HTTP upstream is itself a proxy: we open a plain connection to IT and
    hand it the absolute URI, which is the whole point of that request form.
    Tunnelling here instead (CONNECT to the origin, then speak HTTP through
    the hole) technically moves bytes, but it is wrong twice over: plenty of
    proxies refuse CONNECT to port 80, and the origin server then receives an
    absolute-URI request, which many reject outright. Found by the end-to-end
    test: the origin echoed back `http://host:port/path` as its path. */
    // A bare line goes by what its address was found to speak. One that was
    // never dialled yet is taken as HTTP here: a plain request cannot be
    // re-sent in the other protocol once it is on its way, and the first
    // https:// tunnel (nearly all traffic) or the app's own check settles it.
    let dialed = src
        .dial_with_failover(|up| {
            let h = host.clone();
            async move {
                match upstream::first_try(&up) {
                    Scheme::Http => connect_upstream(&up, UPSTREAM_CONNECT).await.map(|s| (s, Leg::Proxy)),
                    Scheme::Socks5 => dial_through(&up, &h, port).await.map(|s| (s, Leg::Origin)),
                }
            }
        })
        .await;
    // `used` is the upstream that actually carried the connection, which after a
    // failover is NOT the one we started with. Signing with the retired exit's
    // credentials would 407 on the very request the rotation just rescued.
    let (mut server, used, leg) = match dialed {
        Ok(d) => {
            if d.rotated {
                stats.rotated();
            }
            let (stream, leg) = d.stream;
            (Counted::new(stream, Arc::clone(stats)), d.used, leg)
        }
        Err(e) => {
            stats.failed();
            reply_error(&mut client, "502 Bad Gateway", &e.to_string()).await;
            return;
        }
    };

    // An HTTP proxy still wants the absolute URI (it is doing the fetching).
    // A tunnel (SOCKS5, or CONNECT after a second guess) already reaches the
    // origin server, which expects the origin form and would 400 on an
    // absolute one.
    let (line, auth) = match leg {
        Leg::Proxy => (first.clone(), used.basic_header()),
        Leg::Origin => {
            let ver = first.split_whitespace().nth(2).unwrap_or("HTTP/1.1");
            (format!("{method} {path} {ver}"), None)
        }
    };
    let out = rewrite_head(&head, &line, auth.as_deref());
    if server.write_all(&out).await.is_err() {
        return;
    }
    if !leftover.is_empty() && server.write_all(&leftover).await.is_err() {
        return;
    }
    carry(&mut client, &mut server, &mut ticket).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upstream;

    #[test]
    fn finds_the_end_of_a_head() {
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\n\r\nBODY"), Some(18));
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\n"), None);
    }

    #[test]
    fn splits_targets_including_ipv6() {
        assert_eq!(split_target("example.com:443"), Some(("example.com".into(), 443)));
        assert_eq!(split_target("[2001:db8::1]:443"), Some(("2001:db8::1".into(), 443)));
        assert_eq!(split_target("example.com"), None);
    }

    #[test]
    fn splits_absolute_uris() {
        assert_eq!(
            split_absolute_uri("http://example.com/a/b?c=1"),
            Some(("example.com".into(), 80, "/a/b?c=1".into()))
        );
        // No path in the URI still means "/" on the wire.
        assert_eq!(
            split_absolute_uri("http://example.com"),
            Some(("example.com".into(), 80, "/".into()))
        );
        assert_eq!(
            split_absolute_uri("http://example.com:8080/x"),
            Some(("example.com".into(), 8080, "/x".into()))
        );
        // Credentials in the TARGET url are not ours to pass on.
        assert_eq!(
            split_absolute_uri("http://u:p@example.com/x"),
            Some(("example.com".into(), 80, "/x".into()))
        );
        assert_eq!(split_absolute_uri("/just/a/path"), None);
    }

    #[test]
    fn rewriting_injects_auth_and_drops_hop_by_hop_headers() {
        let head = b"GET http://x/ HTTP/1.1\r\nHost: x\r\nProxy-Connection: keep-alive\r\n\
                     Proxy-Authorization: Basic WRONG\r\nConnection: keep-alive\r\n\
                     User-Agent: curl/8\r\n\r\n";
        let out = rewrite_head(head, "GET http://x/ HTTP/1.1", Some("Basic RIGHT"));
        let s = String::from_utf8(out).unwrap();

        assert!(s.contains("Proxy-Authorization: Basic RIGHT"), "{s}");
        // The client's own guess must not survive alongside ours, or the
        // upstream sees two and picks one.
        assert!(!s.contains("WRONG"), "{s}");
        assert!(!s.contains("Proxy-Connection"), "{s}");
        assert!(!s.contains("keep-alive"), "{s}");
        assert!(s.contains("Connection: close"), "{s}");
        // Everything that is not this hop's business is passed through untouched.
        assert!(s.contains("User-Agent: curl/8"), "{s}");
        assert!(s.contains("Host: x"), "{s}");
        assert!(s.ends_with("\r\n\r\n"), "head must end with a blank line: {s:?}");
    }

    #[test]
    fn rewriting_without_auth_adds_no_header() {
        let head = b"GET http://x/ HTTP/1.1\r\nHost: x\r\n\r\n";
        let s = String::from_utf8(rewrite_head(head, "GET http://x/ HTTP/1.1", None)).unwrap();
        assert!(!s.contains("Proxy-Authorization"), "{s}");
    }

    #[test]
    fn socks_reply_codes_are_named() {
        assert_eq!(socks_reply(0x05), "connection refused");
        assert_eq!(socks_reply(0x99), "unknown error");
    }

    #[test]
    fn an_open_upstream_produces_no_auth_header() {
        let up = upstream::parse("203.0.113.42:3128").unwrap();
        assert!(up.basic_header().is_none());
    }

    /// Feed `client_bytes` to the SOCKS5 reader and return what it decided
    /// plus every byte it answered with.
    async fn socks5_exchange(client_bytes: &[u8]) -> (io::Result<Socks5Request>, Vec<u8>) {
        let (mut ours, mut theirs) = tokio::io::duplex(1024);
        theirs.write_all(client_bytes).await.unwrap();
        let result = socks5_read_request(&mut ours).await;
        drop(ours);
        let mut answered = Vec::new();
        let _ = theirs.read_to_end(&mut answered).await;
        (result, answered)
    }

    #[tokio::test]
    async fn a_socks5_client_asking_for_a_name_gets_a_connect() {
        let mut bytes = vec![0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x03, 11];
        bytes.extend_from_slice(b"example.com");
        bytes.extend_from_slice(&443u16.to_be_bytes());
        let (req, answered) = socks5_exchange(&bytes).await;
        assert_eq!(
            req.unwrap(),
            Socks5Request::Connect {
                host: "example.com".into(),
                port: 443
            }
        );
        assert_eq!(answered, vec![0x05, 0x00], "no login method chosen");
    }

    #[tokio::test]
    async fn a_socks5_client_that_insists_on_a_login_is_let_in() {
        // Offers only username/password, sends "u" / "p", asks for an IPv4.
        let bytes = [
            0x05, 0x01, 0x02, 0x01, 0x01, b'u', 0x01, b'p', 0x05, 0x01, 0x00, 0x01, 203, 0, 113, 7, 0x1f, 0x90,
        ];
        let (req, answered) = socks5_exchange(&bytes).await;
        assert_eq!(
            req.unwrap(),
            Socks5Request::Connect {
                host: "203.0.113.7".into(),
                port: 8080
            }
        );
        assert_eq!(
            answered,
            vec![0x05, 0x02, 0x01, 0x00],
            "method 2 chosen, login accepted"
        );
    }

    #[tokio::test]
    async fn a_socks5_client_asking_for_ipv6_is_read_exactly() {
        let mut bytes = vec![0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x04];
        bytes.extend_from_slice(&"2001:db8::1".parse::<Ipv6Addr>().unwrap().octets());
        bytes.extend_from_slice(&443u16.to_be_bytes());
        let (req, _) = socks5_exchange(&bytes).await;
        assert_eq!(
            req.unwrap(),
            Socks5Request::Connect {
                host: "2001:db8::1".into(),
                port: 443
            }
        );
    }

    #[tokio::test]
    async fn udp_and_bind_are_named_as_unsupported_not_mistaken_for_connect() {
        let bytes = [0x05, 0x01, 0x00, 0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
        let (req, _) = socks5_exchange(&bytes).await;
        assert_eq!(req.unwrap(), Socks5Request::Unsupported(0x03));
    }

    #[tokio::test]
    async fn a_socks5_client_with_no_usable_method_is_refused() {
        let bytes = [0x05, 0x01, 0x80];
        let (req, answered) = socks5_exchange(&bytes).await;
        assert!(req.is_err());
        assert_eq!(answered, vec![0x05, 0xff]);
    }

    /// A proxy that accepts the TCP connection and then says nothing must fail
    /// the dial within its budget, or failover never gets its turn.
    #[tokio::test]
    async fn a_silent_upstream_fails_within_the_budget() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            // Accept and hold the socket open without ever answering.
            let held = listener.accept().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(held);
        });
        let up = upstream::parse(&format!("127.0.0.1:{}:u:p", addr.port())).unwrap();
        let started = std::time::Instant::now();
        let err = dial_through_within(
            &up,
            "example.com",
            443,
            Duration::from_millis(500),
            Duration::from_millis(400),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut, "{err}");
        assert!(err.to_string().contains("did not open the way"), "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "took {:?}",
            started.elapsed()
        );
    }

    /// A SOCKS5 server with no login that answers every CONNECT with success
    /// and then echoes. Anything that does not start with the version byte is
    /// dropped at once, as real SOCKS5 servers do. Returns its port and a count
    /// of the connections it accepted.
    async fn fake_socks5() -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&accepted);
        tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                count.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut greeting = [0u8; 2];
                    if s.read_exact(&mut greeting).await.is_err() || greeting[0] != 0x05 {
                        return;
                    }
                    let mut methods = vec![0u8; greeting[1] as usize];
                    if s.read_exact(&mut methods).await.is_err() {
                        return;
                    }
                    let _ = s.write_all(&[0x05, 0x00]).await;
                    let mut req = [0u8; 4];
                    if s.read_exact(&mut req).await.is_err() {
                        return;
                    }
                    let skip = match req[3] {
                        0x01 => 6,
                        0x04 => 18,
                        _ => {
                            let mut len = [0u8; 1];
                            if s.read_exact(&mut len).await.is_err() {
                                return;
                            }
                            len[0] as usize + 2
                        }
                    };
                    let mut rest = vec![0u8; skip];
                    if s.read_exact(&mut rest).await.is_err() {
                        return;
                    }
                    let _ = s.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
                    let mut buf = [0u8; 64];
                    while let Ok(n) = s.read(&mut buf).await {
                        if n == 0 || s.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        (port, accepted)
    }

    async fn says_ping_back(mut s: TcpStream) {
        s.write_all(b"ping").await.unwrap();
        let mut back = [0u8; 4];
        s.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"ping");
    }

    /// The bug this guards: a bare `host:port` SOCKS5 proxy checked as working
    /// and then dialled as HTTP, so Connect carried nothing.
    #[tokio::test]
    async fn a_bare_line_to_a_socks5_proxy_is_dialled_as_socks5() {
        let (port, accepted) = fake_socks5().await;
        let up = upstream::parse(&format!("127.0.0.1:{port}")).unwrap();

        let s = dial_through(&up, "example.com", 443)
            .await
            .expect("the second guess should carry it");
        says_ping_back(s).await;
        assert_eq!(upstream::first_try(&up), Scheme::Socks5, "what it speaks is remembered");
        assert_eq!(
            accepted.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "HTTP first, then SOCKS5"
        );

        // The next connection goes straight to SOCKS5: one more accept, not two.
        let s = dial_through(&up, "example.com", 443).await.unwrap();
        says_ping_back(s).await;
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    /// "http://" in front of a SOCKS5 proxy is a common slip. The checker
    /// reports what answered whatever the prefix says, and so does the relay.
    #[tokio::test]
    async fn a_wrong_prefix_does_not_stop_the_connection() {
        let (port, accepted) = fake_socks5().await;
        let up = upstream::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let s = dial_through(&up, "example.com", 443)
            .await
            .expect("SOCKS5 should carry it");
        says_ping_back(s).await;
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(upstream::first_try(&up), Scheme::Socks5);
    }

    /// An HTTP proxy that says no is still an HTTP proxy: its answer is
    /// reported, and nothing is tried in SOCKS5.
    #[tokio::test]
    async fn an_http_refusal_is_reported_not_second_guessed() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&accepted);
        tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                count.fetch_add(1, Ordering::SeqCst);
                let _ = read_head(&mut s).await;
                let _ = s
                    .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
                    .await;
            }
        });
        let up = upstream::parse(&format!("127.0.0.1:{port}:user:wrong")).unwrap();
        let err = dial_through(&up, "example.com", 443).await.unwrap_err();
        assert!(err.to_string().contains("407"), "{err}");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
        assert_eq!(upstream::first_try(&up), Scheme::Http);
    }

    /// An HTTP proxy that drops a CONNECT without a word gets one SOCKS5
    /// greeting, which it ignores; the second guess gives up within its short
    /// limit and the first answer is the one reported.
    #[tokio::test]
    async fn a_silent_second_guess_gives_up_quickly() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut first = true;
            while let Ok((s, _)) = listener.accept().await {
                if first {
                    first = false;
                    drop(s);
                } else {
                    // Hold the second connection open and say nothing.
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(20)).await;
                        drop(s);
                    });
                }
            }
        });
        let up = upstream::parse(&format!("127.0.0.1:{port}")).unwrap();
        let started = std::time::Instant::now();
        let err = dial_through(&up, "example.com", 443).await.unwrap_err();
        assert!(err.to_string().contains("without an HTTP answer"), "{err}");
        assert!(started.elapsed() < SECOND_GUESS_GREETING + Duration::from_secs(2));
        assert_eq!(upstream::first_try(&up), Scheme::Http, "nothing was learned");
    }

    #[tokio::test]
    async fn a_refused_upstream_says_so_quickly() {
        // Bind then drop, so the port is closed.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let up = upstream::parse(&format!("127.0.0.1:{port}")).unwrap();
        let err = connect_upstream(&up, Duration::from_secs(5)).await.unwrap_err();
        assert!(err.to_string().contains("could not reach the proxy"), "{err}");
    }
}
