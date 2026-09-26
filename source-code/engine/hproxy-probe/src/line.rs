//! The one parser for the one string a customer actually has: their proxy line.
//!
//! Every shape a provider prints or a person pastes is accepted, because a tool
//! that took only one of them would move the rearranging problem rather than
//! solve it. This is the union of the three parsers that used to exist (the
//! website's, the desktop app's and the connector's), with the connector's
//! error messages, because on a command line the error text is the whole UX.
//!
//! Accepted, among others:
//!
//! ```text
//!   1.2.3.4:8080                          bare
//!   socks5://1.2.3.4:8080                 scheme kept as a hint
//!   user:pass@1.2.3.4:8080                URL auth
//!   1.2.3.4:8080:user:pass                the shape most sellers print
//!   1.2.3.4:8080@user:pass                reverse auth
//!   1.2.3.4,8080,user,pass                CSV
//!   1.2.3.4|8080|user|pass                pipes
//!   1.2.3.4 8080 user pass                spaces or tabs
//!   gateway.vendor.com:8000:user:pass     a hostname (residential gateways)
//!   [2001:db8::1]:8080:user:pass          bracketed IPv6
//!   2001:db8::1:8080                      unbracketed IPv6, split from the right
//!   http://u:p@1.2.3.4:8080/some/path     scheme, auth and a path, all stripped
//!   1.2.3.4;8080;user;pass                semicolons (spreadsheets in much of Europe)
//!   "1.2.3.4","8080","user","pass"        quoted CSV
//!   1.2.3.4:8080 # fast one               a note after the proxy
//!   IP: 1.2.3.4 Port: 8080                labelled text copied from a page
//!   socks5 1.2.3.4 1080                   a protocol word, kept as a hint
//!   [1.2.3.4]:8080                        IPv4 in brackets
//!   1.2.3.4：8080                          full-width punctuation and digits
//!   {"ip":"1.2.3.4","port":8080}          a JSON object, read by its keys
//! ```
//!
//! A password containing `:`, `@`, `/`, `?` or `#` survives, because losing its
//! tail produces a login failure the customer cannot see the cause of.
//!
//! Every shape above, and every line that must be refused, is in
//! `tests/fixtures/proxy-lines.json`, which the extension's `line.js` and the
//! desktop app are tested against too, so the three read a list the same way.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// The transport a scheme prefix asked for. The checker ignores it and probes
/// everything, reporting what actually answered; the relay honours it, because
/// a relay has to pick one way to speak to the upstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scheme {
    Http,
    Socks4,
    Socks5,
}

/// One parsed proxy line.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProxyLine {
    pub host: String,
    pub port: u16,
    /// `(user, pass)`. Absent for open proxies and IP-authorised ones.
    pub auth: Option<(String, String)>,
    /// What the scheme prefix said, when there was one.
    pub scheme: Option<Scheme>,
}

impl ProxyLine {
    /// `host:port`, with IPv6 in brackets so it can be dialled and printed.
    pub fn addr(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    /// The host is an IP literal rather than a name.
    pub fn is_literal(&self) -> bool {
        self.host.parse::<IpAddr>().is_ok()
    }

    /// What makes two lines the same proxy: host, port and login. The scheme
    /// hint is left out, because `1.2.3.4:80` and `http://1.2.3.4:80` are one
    /// proxy and checking it twice costs a real socket for an answer we have.
    pub fn key(&self) -> (String, u16, Option<(String, String)>) {
        (self.host.to_ascii_lowercase(), self.port, self.auth.clone())
    }

    /// The `Proxy-Authorization` header value, when there is a login.
    pub fn basic_header(&self) -> Option<String> {
        self.auth
            .as_ref()
            .map(|(u, p)| format!("Basic {}", b64(format!("{u}:{p}").as_bytes())))
    }
}

impl fmt::Display for ProxyLine {
    /// Never prints the password. This goes in banners and logs, and a banner
    /// is the thing people paste into a support chat.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let scheme = match self.scheme {
            Some(Scheme::Http) => "http://",
            Some(Scheme::Socks4) => "socks4://",
            Some(Scheme::Socks5) => "socks5://",
            None => "",
        };
        match &self.auth {
            Some((u, _)) => write!(f, "{scheme}{u}:********@{}", self.addr()),
            None => write!(f, "{scheme}{}", self.addr()),
        }
    }
}

/// Why a line could not be read. The text is written for the person who
/// typed the line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineError(pub String);

impl fmt::Display for LineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LineError {}

fn err<T>(msg: impl Into<String>) -> Result<T, LineError> {
    Err(LineError(msg.into()))
}

/// Longest line worth tokenising. A valid line, even a bracketed IPv6 with a
/// login, is well under this; anything longer is junk or hostile.
const MAX_LINE_LEN: usize = 512;

/// Longest JSON object line: a provider's export carries a dozen fields
/// (country, city, speed, uptime...) beside the four that matter.
const MAX_JSON_LEN: usize = 4096;

/// Longest a DNS name may be (RFC 1035).
const MAX_HOST_LEN: usize = 253;

/// Standard base64, no line breaks. Twenty lines, versus asking a customer to
/// trust another crate in a binary they downloaded from us.
pub fn b64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// A token we are willing to dial as a DNS name: labels of 1..=63 characters
/// from `[A-Za-z0-9-]`, no leading or trailing hyphen, and a non-numeric last
/// label. The numeric-last-label rule keeps `1.2.3.999` from being dialled as a
/// hostname: an all-digit final label means the token was an address that
/// failed to parse, and resolving it would turn a typo into a DNS lookup.
/// Single-label names (`localhost`, `squid`, a LAN box) are accepted: on a
/// desktop and in a container they are real proxies.
pub fn is_hostname(s: &str) -> bool {
    if s.is_empty() || s.len() > MAX_HOST_LEN {
        return false;
    }
    let mut last = "";
    for label in s.split('.') {
        if label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return false;
        }
        last = label;
    }
    !last.bytes().all(|b| b.is_ascii_digit())
}

fn is_dialable_host(s: &str) -> bool {
    s.parse::<IpAddr>().is_ok() || is_hostname(s)
}

/// `user:pass` to `Some((user, pass))`. Splits on the FIRST colon, so a
/// password containing colons survives intact.
fn split_credentials(s: &str) -> Option<(String, String)> {
    let (user, pass) = match s.split_once(':') {
        Some((u, p)) => (u, p),
        None => (s, ""),
    };
    (!user.is_empty() || !pass.is_empty()).then(|| (user.to_string(), pass.to_string()))
}

/// The endpoint half of a line, no credentials: `[v6]:port`, `v6:port`
/// (unbracketed, split from the right) or `host:port`.
fn parse_host_port(s: &str) -> Option<(String, u16)> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(rest) = s.strip_prefix('[') {
        let close = rest.find(']')?;
        let host = &rest[..close];
        // IPv6 is why brackets exist, but `[1.2.3.4]:8080` is pasted too.
        host.parse::<IpAddr>().ok()?;
        let port: u16 = rest[close + 1..].trim_start_matches(':').parse().ok()?;
        return (port > 0).then(|| (host.to_string(), port));
    }
    let (host, port_str) = s.rsplit_once(':')?;
    let port: u16 = port_str.parse().ok()?;
    if port == 0 || !is_dialable_host(host) {
        return None;
    }
    Some((host.to_string(), port))
}

/// How convincing a token is as the HOST of a proxy: an IP literal beats a
/// dotted name, which beats a single label, which beats nothing. Used only to
/// choose between two readings of one four-field line.
fn host_strength(s: &str) -> u8 {
    if s.parse::<IpAddr>().is_ok() {
        3
    } else if is_hostname(s) && s.contains('.') {
        2
    } else if is_hostname(s) {
        1
    } else {
        0
    }
}

/// Characters that are not whitespace to Rust but arrive at the edges of
/// pasted lines anyway: the byte-order mark Notepad and Excel write at the
/// start of a "UTF-8" file, and the zero-width marks web pages carry. Left in,
/// the first line of such a file reads as "could not read".
fn is_edge_junk(c: char) -> bool {
    c.is_whitespace() || matches!(c, '\u{feff}' | '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}')
}

/// The full-width forms of the separators and digits (East Asian pages and
/// keyboards) and the no-break space (word processors, web tables), folded to
/// ASCII before anything is read, so `1.2.3.4：8080` is `1.2.3.4:8080`.
fn fold_lookalikes(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\u{ff1a}' => ':',
            '\u{ff0c}' => ',',
            '\u{ff1b}' => ';',
            '\u{ff20}' => '@',
            '\u{ff5c}' => '|',
            '\u{ff0e}' => '.',
            '\u{ff0f}' => '/',
            '\u{3000}' | '\u{00a0}' => ' ',
            '\u{ff10}'..='\u{ff19}' => char::from_u32(c as u32 - 0xff10 + '0' as u32).unwrap_or(c),
            _ => c,
        })
        .collect()
}

/// `1.2.3.4:8080 # fast one`: a note after the proxy, cut where a `#` follows
/// whitespace. A `#` inside a password has no space in front of it and stays.
fn strip_trailing_note(s: &str) -> &str {
    let b = s.as_bytes();
    for i in 1..b.len() {
        if b[i] == b'#' && (b[i - 1] == b' ' || b[i - 1] == b'\t') {
            return s[..i].trim_end();
        }
    }
    s
}

/// Quotes around fields, as spreadsheets write CSV: `"1.2.3.4","8080"`. A quote
/// goes only where it touches a separator or an end of the line, so an
/// apostrophe inside a password stays.
fn unquote_fields(s: &str) -> String {
    if !s.contains(['"', '\'']) {
        return s.to_string();
    }
    let chars: Vec<char> = s.chars().collect();
    let at_edge = |c: Option<&char>| c.is_none_or(|c| matches!(c, ',' | ';' | '|' | '\t' | ' '));
    chars
        .iter()
        .enumerate()
        .filter(|&(i, c)| {
            if *c != '"' && *c != '\'' {
                return true;
            }
            let prev = if i == 0 { None } else { chars.get(i - 1) };
            !(at_edge(prev) || at_edge(chars.get(i + 1)))
        })
        .map(|(_, c)| *c)
        .collect()
}

/// The words pages print in front of each field: `IP: 1.2.3.4 Port: 8080`.
const LABELS: [&str; 16] = [
    "ip", "host", "hostname", "address", "server", "proxy", "port", "user", "username", "login", "pass", "password",
    "pwd", "type", "protocol", "country",
];

/// Labelled text copied from a page, `IP: 1.2.3.4 Port: 8080 User: bob`. A
/// label only counts when a space follows its `:` or `=`, so the username in
/// `user:pass@1.2.3.4:8080` is never taken for one. Without this, `Port` was
/// read as a host name, on port 8080.
fn drop_labels(s: &str) -> String {
    let words: Vec<&str> = s.split(' ').filter(|w| !w.is_empty()).collect();
    let is_label = |w: &str| {
        let w = w.trim_end_matches([':', '=']);
        LABELS.contains(&w.to_ascii_lowercase().as_str())
    };
    let mut kept = Vec::with_capacity(words.len());
    let mut dropped = false;
    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        // `IP:` or `IP=`, with the value in the next word.
        if (w.ends_with(':') || w.ends_with('=')) && is_label(w) && i + 1 < words.len() {
            dropped = true;
            i += 1;
            continue;
        }
        // `IP :` with the separator on its own.
        if is_label(w) && matches!(words.get(i + 1), Some(&":") | Some(&"=")) {
            dropped = true;
            i += 2;
            continue;
        }
        kept.push(w);
        i += 1;
    }
    if dropped {
        kept.join(" ")
    } else {
        s.to_string()
    }
}

/// A trailing path, query or fragment, as in `http://u:p@h.example.com:1/echo?x=1`
/// and `1.2.3.4:8080/some/path`, cut only where it follows `host:port`: digits
/// after a colon, with an IP address, a dotted name or a bracketed IPv6 in
/// front of them. Cutting at the first `/`, `?` or `#` anywhere used to
/// shorten a password such as `pa/ss` to `pa`, silently; and `user:12/34` is a
/// numeric password, not a port with a path.
fn strip_path(s: &str) -> &str {
    let b = s.as_bytes();
    for (i, &c) in b.iter().enumerate() {
        if !matches!(c, b'/' | b'?' | b'#') {
            continue;
        }
        let digits = b[..i].iter().rev().take_while(|d| d.is_ascii_digit()).count();
        if !(1..=5).contains(&digits) || i <= digits || b[i - digits - 1] != b':' {
            continue;
        }
        let before = &s[..i - digits - 1];
        let host = before
            .rsplit(['@', ':', ',', ';', '|', ' ', '\t', '/'])
            .next()
            .unwrap_or(before);
        if before.ends_with(']') || host.parse::<Ipv4Addr>().is_ok() || (is_hostname(host) && host.contains('.')) {
            return &s[..i];
        }
    }
    s
}

/// A protocol written as a word of its own: `socks5 1.2.3.4 1080`.
fn scheme_word(s: &str) -> Option<Scheme> {
    match s.trim().to_ascii_lowercase().as_str() {
        "http" | "https" => Some(Scheme::Http),
        "socks5" | "socks5h" | "socks" => Some(Scheme::Socks5),
        "socks4" | "socks4a" => Some(Scheme::Socks4),
        _ => None,
    }
}

/// A JSON object on one line, as several providers export their lists:
/// `{"ip":"1.2.3.4","port":8080,"username":"u","password":"p","protocol":"socks5"}`.
/// Read by its keys, under the names providers use (case, `_` and `-` ignored),
/// or a whole proxy line under `proxy`/`url`.
fn from_json(s: &str, raw: &str) -> Result<ProxyLine, LineError> {
    let Ok(serde_json::Value::Object(o)) = serde_json::from_str::<serde_json::Value>(s) else {
        return err(format!("`{raw}` looks like JSON but could not be read"));
    };
    let get = |keys: &[&str]| -> Option<String> {
        for (k, v) in &o {
            let k = k.to_ascii_lowercase().replace(['_', '-'], "");
            if !keys.contains(&k.as_str()) {
                continue;
            }
            let found = match v {
                serde_json::Value::String(s) => s.trim().to_string(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Array(a) => match a.first() {
                    Some(serde_json::Value::String(s)) => s.trim().to_string(),
                    _ => String::new(),
                },
                _ => String::new(),
            };
            if !found.is_empty() {
                return Some(found);
            }
        }
        None
    };
    // The whole line under one key: {"proxy": "http://u:p@1.2.3.4:8080"}.
    if let Some(line) = get(&["proxy", "url", "line"]) {
        if !line.starts_with('{') {
            if let Ok(p) = parse(&line) {
                return Ok(p);
            }
        }
    }
    let host = get(&[
        "ip",
        "ipaddress",
        "host",
        "hostname",
        "server",
        "address",
        "addr",
        "proxyaddress",
        "proxyhost",
        "proxyip",
    ]);
    let port = get(&["port", "proxyport"])
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|p| *p > 0);
    let (Some(host), Some(port)) = (host, port) else {
        return err(format!("`{raw}` is a JSON object without an ip and a port"));
    };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    if !is_dialable_host(&host) {
        return err(format!("`{host}` is not an address or a host name"));
    }
    let user = get(&["username", "user", "login", "proxyusername", "proxyuser"]);
    let pass = get(&["password", "pass", "pwd", "proxypassword", "proxypass"]);
    let auth = match (user, pass) {
        (Some(u), p) => Some((u, p.unwrap_or_default())),
        (None, _) => None,
    };
    let scheme = get(&["protocol", "protocols", "type", "scheme"]).and_then(|p| scheme_word(&p));
    Ok(ProxyLine {
        host,
        port,
        auth,
        scheme,
    })
}

fn strip_scheme(s: &str) -> (Option<Scheme>, &str) {
    let lower = s.to_ascii_lowercase();
    let known: [(&str, Option<Scheme>); 6] = [
        ("http://", Some(Scheme::Http)),
        // A proxy URL's scheme describes how you speak TO the proxy, and that is
        // plain HTTP even when every site you visit is HTTPS. Writing https:// is
        // a very common mix-up, and failing on it would look like the proxy is
        // broken.
        ("https://", Some(Scheme::Http)),
        ("socks5h://", Some(Scheme::Socks5)),
        ("socks5://", Some(Scheme::Socks5)),
        ("socks4a://", Some(Scheme::Socks4)),
        ("socks4://", Some(Scheme::Socks4)),
    ];
    for (prefix, scheme) in known {
        if lower.starts_with(prefix) {
            return (scheme, &s[prefix.len()..]);
        }
    }
    // Any other scheme: drop it, keep going, do not narrow the probe.
    match s.split_once("://") {
        Some((_, rest)) => (None, rest),
        None => (None, s),
    }
}

/// Read one line. Blank lines and `#` comments are an error too, because the
/// caller decides whether to skip them; the message says which they were.
pub fn parse(raw: &str) -> Result<ProxyLine, LineError> {
    let folded = fold_lookalikes(raw);
    let s = folded.trim_matches(is_edge_junk);
    if s.is_empty() {
        return err("empty line");
    }
    if s.starts_with('#') {
        return err("a comment, not a proxy");
    }
    if s.starts_with('{') && s.ends_with('}') {
        if s.len() > MAX_JSON_LEN {
            return err("the line is too long to be a proxy");
        }
        return from_json(s, raw);
    }
    if s.len() > MAX_LINE_LEN {
        return err("the line is too long to be a proxy");
    }
    let unquoted = unquote_fields(strip_trailing_note(s));
    let labelled = drop_labels(&unquoted);
    let s = labelled.trim_matches(is_edge_junk);
    if s.is_empty() {
        return err(format!(
            "`{raw}` has no host. A proxy needs a host and a port, like 198.51.100.7:8080."
        ));
    }

    let (scheme, rest) = strip_scheme(s);
    // A trailing path, query or fragment is stripped before anything counts
    // colons: `1.2.3.4:8080/foo` and `http://u:p@h.example.com:1/echo?x=1` are both real
    // pastes. Only where it follows a port, so a password keeps its `/`.
    let rest = strip_path(rest).trim();
    if rest.is_empty() {
        return err(format!(
            "`{raw}` has no host. A proxy needs a host and a port, like 198.51.100.7:8080."
        ));
    }

    let done = |host: String, port: u16, auth: Option<(String, String)>| {
        Ok(ProxyLine {
            host,
            port,
            auth,
            scheme,
        })
    };

    // URL form `creds@endpoint`, and its mirror `endpoint@creds`. Split on the
    // LAST '@' so a password containing '@' cannot steal the host.
    if let Some(at) = rest.rfind('@') {
        let (left, right) = (&rest[..at], &rest[at + 1..]);
        if let Some((host, port)) = parse_host_port(right) {
            return done(host, port, split_credentials(left));
        }
        if let Some((host, port)) = parse_host_port(left) {
            return done(host, port, split_credentials(right));
        }
        return err(format!(
            "could not find host:port on either side of the @ in `{raw}`. \
             The shape is username:password@host:port."
        ));
    }

    // Bracketed IPv6, optionally followed by `:user:pass`. Recognised before
    // anything counts colons, because the address is itself full of them.
    if let Some(after) = rest.strip_prefix('[') {
        let Some(close) = after.find(']') else {
            return err(format!("unclosed IPv6 bracket in `{raw}`"));
        };
        let host = &after[..close];
        // IPv6 is why brackets exist, but `[1.2.3.4]:8080` is pasted too.
        if host.parse::<IpAddr>().is_err() {
            return err(format!("`{host}` is not an IP address"));
        }
        let tail: Vec<&str> = after[close + 1..].split(':').filter(|t| !t.is_empty()).collect();
        let Some(port) = tail.first().and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0) else {
            return err(format!("no port after the IPv6 address in `{raw}`"));
        };
        // Three fields after the address: port, user, pass. The password is the
        // LAST field and may not contain colons in this shape (they would be
        // read as more fields), which is the same rule every seller's export
        // follows.
        let auth = match tail.len() {
            1 => None,
            3 => Some((tail[1].to_string(), tail[2].to_string())),
            _ => return err("that looks like the wrong number of fields after the IPv6 address. Use [addr]:port or [addr]:port:username:password."),
        };
        return done(host.to_string(), port, auth);
    }

    // Unbracketed IPv6: `v6:port`, then `v6:port:user:pass`. Tried before the
    // delimiter tokeniser because ':' is both the address separator and the
    // field separator, so tokenising shreds the address.
    if rest.matches(':').count() >= 2 && !rest.contains([',', ';', '|', '\t', ' ']) {
        if let Some((host, port)) = parse_host_port(rest) {
            if host.parse::<Ipv6Addr>().is_ok() {
                return done(host, port, None);
            }
        }
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() >= 4 {
            let head = parts[..parts.len() - 2].join(":");
            if let Some((host, port)) = parse_host_port(&head) {
                if host.parse::<Ipv6Addr>().is_ok() {
                    let auth = Some((parts[parts.len() - 2].to_string(), parts[parts.len() - 1].to_string()));
                    return done(host, port, auth);
                }
            }
        }
    }

    // The common colon shape, with the password allowed to contain colons and
    // spaces: `host:port:user:pa:ss` is four fields split at most four ways.
    if !rest.contains([',', '|', '\t', '@']) {
        let parts: Vec<&str> = rest.splitn(4, ':').collect();
        match parts.len() {
            2 => {
                if let Some((host, port)) = parse_host_port(rest) {
                    return done(host, port, None);
                }
            }
            4 => {
                // Two readings of four fields: host:port:user:pass (what sellers
                // print) and user:pass:host:port. Both can parse when the
                // password is a number, and then the stronger host wins:
                // `user1:12345:gate.example.com:8000` is a login in front of a
                // gateway, not a proxy called `user1` on port 12345. A tie keeps
                // the seller convention.
                let port_of = |p: &str| p.parse::<u16>().ok().filter(|p| *p > 0);
                let host_first = port_of(parts[1]).map(|p| (host_strength(parts[0]), p));
                let user_first = port_of(parts[3]).map(|p| (host_strength(parts[2]), p));
                match (host_first, user_first) {
                    (Some((a, port)), other) if a > 0 && other.is_none_or(|(b, _)| a >= b) => {
                        return done(
                            parts[0].to_string(),
                            port,
                            Some((parts[2].to_string(), parts[3].to_string())),
                        );
                    }
                    (_, Some((b, port))) if b > 0 => {
                        return done(
                            parts[2].to_string(),
                            port,
                            Some((parts[0].to_string(), parts[1].to_string())),
                        );
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    // Everything else: tokenise by every delimiter people paste. A semicolon
    // counts only here, after the colon shape had its turn, so a password in
    // `host:port:user:pa;ss` keeps its `;`. A protocol written as a word of its
    // own (`socks5 1.2.3.4 1080`) becomes the scheme hint, not half a login.
    let mut word_scheme = None;
    let tokens: Vec<&str> = rest
        .split([':', '@', ',', ';', '|', '\t', ' '])
        .filter(|t| !t.is_empty())
        .filter(|t| match scheme_word(t) {
            Some(sc) => {
                word_scheme.get_or_insert(sc);
                false
            }
            None => true,
        })
        .collect();
    let scheme = scheme.or(word_scheme);

    // IP literals first, then dotted names, then single labels: a hostname
    // token is far easier to confuse with a username than an IP is, and a
    // single label (`user1`) far easier than a dotted gateway name.
    let accepts: [fn(&str) -> bool; 3] = [
        |t| t.parse::<Ipv4Addr>().is_ok(),
        |t| is_hostname(t) && t.contains('.'),
        is_hostname,
    ];
    for accept in accepts {
        for i in 0..tokens.len().saturating_sub(1) {
            if !accept(tokens[i]) {
                continue;
            }
            let Ok(port) = tokens[i + 1].parse::<u16>() else {
                continue;
            };
            if port == 0 {
                continue;
            }
            let others: Vec<&str> = tokens
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i && *j != i + 1)
                .map(|(_, t)| *t)
                .collect();
            // Exactly two leftover tokens are a login, in their original order.
            // Anything else is not guessed: a wrong credential reads to the
            // customer exactly like a dead proxy.
            let auth = (others.len() == 2).then(|| (others[0].to_string(), others[1].to_string()));
            return Ok(ProxyLine {
                host: tokens[i].to_string(),
                port,
                auth,
                scheme,
            });
        }
    }

    // Specific messages for the mistakes people actually make.
    if !rest.contains(':') && !rest.contains([',', '|', '\t', ' ']) {
        return err(format!(
            "`{raw}` has no port. A proxy needs a host and a port, like 198.51.100.7:8080."
        ));
    }
    if let Some((h, p)) = rest.rsplit_once(':') {
        if p.parse::<u16>().is_err() && !p.is_empty() && is_dialable_host(h) {
            return err(format!("`{p}` is not a port number. It should be something like 8080."));
        }
    }
    if rest.split(':').count() == 3 {
        return err("that looks like three fields. A proxy line is either host:port or host:port:username:password.");
    }
    err(format!(
        "could not read `{raw}` as a proxy. Try host:port or host:port:username:password."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(s: &str) -> ProxyLine {
        parse(s).unwrap_or_else(|e| panic!("{s} failed: {e}"))
    }

    fn auth(u: &str, p: &str) -> Option<(String, String)> {
        Some((u.to_string(), p.to_string()))
    }

    #[test]
    fn plain_host_port() {
        let l = line("203.0.113.20:8080");
        assert_eq!(
            (l.host.as_str(), l.port, l.auth, l.scheme),
            ("203.0.113.20", 8080, None, None)
        );
    }

    #[test]
    fn the_colon_shape_most_sellers_print() {
        let l = line("198.51.100.44:3128:bob:secret");
        assert_eq!(l.auth, auth("bob", "secret"));
        assert_eq!(l.port, 3128);
    }

    #[test]
    fn url_auth() {
        let l = line("bob:secret@198.51.100.44:3128");
        assert_eq!(l.host, "198.51.100.44");
        assert_eq!(l.auth, auth("bob", "secret"));
    }

    #[test]
    fn reverse_auth() {
        let l = line("1.2.3.4:8080@myuser:mypass");
        assert_eq!(l.host, "1.2.3.4");
        assert_eq!(l.auth, auth("myuser", "mypass"));
    }

    #[test]
    fn schemes_are_kept_as_hints() {
        assert_eq!(line("socks5://192.0.2.8:1080").scheme, Some(Scheme::Socks5));
        assert_eq!(line("socks5h://u:p@h.example.com:1080").scheme, Some(Scheme::Socks5));
        assert_eq!(line("socks4://1.2.3.4:1080").scheme, Some(Scheme::Socks4));
        assert_eq!(line("http://bob:secret@1.2.3.4:80").scheme, Some(Scheme::Http));
        // https:// for a proxy URL is a common mix-up and means plain HTTP.
        assert_eq!(line("https://u:p@h.example.com:1").scheme, Some(Scheme::Http));
        assert_eq!(line("1.2.3.4:80").scheme, None);
        // An unknown scheme is dropped, never fatal.
        assert_eq!(line("shadowsocks://1.2.3.4:80").scheme, None);
    }

    #[test]
    fn csv_pipes_tabs_and_spaces() {
        for s in [
            "1.2.3.4,8080,myuser,mypass",
            "1.2.3.4|8080|myuser|mypass",
            "1.2.3.4\t8080\tmyuser\tmypass",
            "1.2.3.4 8080 myuser mypass",
        ] {
            let l = line(s);
            assert_eq!((l.host.as_str(), l.port), ("1.2.3.4", 8080), "{s}");
            assert_eq!(l.auth, auth("myuser", "mypass"), "{s}");
        }
    }

    #[test]
    fn user_pass_prefix_colon_form() {
        let l = line("myuser:mypass:1.2.3.4:8080");
        assert_eq!((l.host.as_str(), l.port), ("1.2.3.4", 8080));
        assert_eq!(l.auth, auth("myuser", "mypass"));
    }

    #[test]
    fn a_password_containing_colons_survives_the_colon_shape() {
        let l = line("h.example.com:8080:user:9f:a2:c1");
        assert_eq!(l.auth, auth("user", "9f:a2:c1"));
        let l = line("1.2.3.4:8080:user:9f:a2:c1");
        assert_eq!(l.auth, auth("user", "9f:a2:c1"));
    }

    #[test]
    fn a_password_containing_an_at_sign_survives() {
        let l = line("user:p@ss@198.51.100.7:8080");
        assert_eq!(l.auth, auth("user", "p@ss"));
        assert_eq!(l.host, "198.51.100.7");
    }

    #[test]
    fn a_password_containing_a_colon_survives_url_auth() {
        let l = line("user:a:b@1.2.3.4:8080");
        assert_eq!(l.auth, auth("user", "a:b"));
    }

    #[test]
    fn gateway_hostnames() {
        assert_eq!(line("gate.example.net:30").host, "gate.example.net");
        let l = line("user-country-us:pass1234@gate.example.net:30");
        assert_eq!(l.host, "gate.example.net");
        assert_eq!(l.auth, auth("user-country-us", "pass1234"));
        let l = line("proxy.example.org:7000:user1:pass1");
        assert_eq!(l.host, "proxy.example.org");
        assert_eq!(l.auth, auth("user1", "pass1"));
        assert_eq!(line("localhost:3128").host, "localhost");
    }

    #[test]
    fn bracketed_ipv6() {
        let l = line("[2001:db8::1]:8080");
        assert_eq!((l.host.as_str(), l.port, l.auth.clone()), ("2001:db8::1", 8080, None));
        assert_eq!(l.addr(), "[2001:db8::1]:8080");
        let l = line("[2a02:c207:3020:3781::b2]:8080:u:p");
        assert_eq!(l.auth, auth("u", "p"));
        let l = line("u:p@[2a02:c207:3020:3781::b2]:8080");
        assert_eq!(l.host, "2a02:c207:3020:3781::b2");
        assert_eq!(l.auth, auth("u", "p"));
        assert_eq!(line("[::1]:3128").host, "::1");
    }

    #[test]
    fn unbracketed_ipv6() {
        let l = line("2a02:c207:3020:3781::b2:8080");
        assert_eq!((l.host.as_str(), l.port), ("2a02:c207:3020:3781::b2", 8080));
        let l = line("2a02:c207:3020:3781::b2:8080:u:p");
        assert_eq!(l.host, "2a02:c207:3020:3781::b2");
        assert_eq!(l.auth, auth("u", "p"));
    }

    #[test]
    fn scheme_auth_and_path_all_stripped() {
        let l = line("http://user:pass@1.2.3.4:8080/echo?x=1");
        assert_eq!((l.host.as_str(), l.port), ("1.2.3.4", 8080));
        assert_eq!(l.auth, auth("user", "pass"));
        assert_eq!(line("1.2.3.4:8080/some/path").port, 8080);
    }

    #[test]
    fn runs_of_separators_are_squashed() {
        assert_eq!(line("1.2.3.4::8080").port, 8080);
        assert_eq!(line("1.2.3.4  8080").port, 8080);
    }

    #[test]
    fn ambiguous_leftovers_never_guess_a_credential() {
        let l = line("1.2.3.4:8080:a:b:c");
        // Four-way split keeps `b:c` as the password in the colon shape, which
        // is the seller convention; the tokeniser never sees it.
        assert_eq!(l.auth, auth("a", "b:c"));
        let l = line("1.2.3.4 8080 a b c");
        assert_eq!(l.auth, None, "three leftovers are not a login");
    }

    #[test]
    fn junk_is_rejected_with_a_reason() {
        assert!(parse("").is_err());
        assert!(parse("   ").is_err());
        assert!(parse("# comment").unwrap_err().0.contains("comment"));
        assert!(parse("not a proxy").is_err());
        assert!(parse("1.2.3.4").unwrap_err().0.contains("no port"));
        assert!(parse("1.2.3.4:notaport").unwrap_err().0.contains("port number"));
        // A missing password is not a dead proxy: the endpoint is still read,
        // and a login is never guessed from one leftover token.
        assert_eq!(line("h.example.com:1:user").auth, None);
        assert!(parse("999.999.999.999:80").is_err());
        assert!(parse("1.2.3.4:0").is_err());
        assert!(parse("1.2.3.4:99999").is_err());
        let huge = format!("1.2.3.4:8080:{}", "a".repeat(600));
        assert!(parse(&huge).is_err());
    }

    #[test]
    fn a_malformed_address_is_not_a_hostname() {
        assert!(!is_hostname("1.2.3.999"));
        assert!(!is_hostname("192.168.1.1"));
        assert!(is_hostname("gate.example.com"));
        assert!(is_hostname("localhost"));
        assert!(!is_hostname("-bad.example.com"));
        assert!(
            is_hostname("squid"),
            "a single-label LAN or container name is a real proxy"
        );
        assert!(!is_hostname("8080"));
    }

    #[test]
    fn display_never_prints_the_password() {
        let shown = format!("{}", line("h.example.com:1:user:hunter2"));
        assert!(!shown.contains("hunter2"), "{shown}");
        assert!(shown.contains("user"), "{shown}");
        assert_eq!(format!("{}", line("socks5://1.2.3.4:1080")), "socks5://1.2.3.4:1080");
    }

    #[test]
    fn base64_matches_the_rfc_vectors() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
        let l = line("h.example.com:1:Aladdin:open sesame");
        assert_eq!(l.basic_header().unwrap(), "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
        assert!(line("203.0.113.42:3128").basic_header().is_none());
    }

    #[test]
    fn the_key_ignores_the_scheme_hint_for_deduplication() {
        assert_eq!(line("1.2.3.4:80").key(), line("http://1.2.3.4:80/").key());
        assert_eq!(line("Gate.Example.com:80").key(), line("gate.example.com:80").key());
        assert_ne!(line("1.2.3.4:80").key(), line("1.2.3.4:81").key());
        assert_ne!(line("1.2.3.4:80").key(), line("1.2.3.4:80:u:p").key());
    }

    /// Notepad and Excel save "UTF-8" with a byte-order mark, and pages copied
    /// from the web carry zero-width marks. Neither is whitespace to Rust.
    #[test]
    fn a_byte_order_mark_or_zero_width_edge_is_ignored() {
        let l = line("\u{feff}198.51.100.7:8080:user:pass");
        assert_eq!((l.host.as_str(), l.port), ("198.51.100.7", 8080));
        assert_eq!(l.auth, auth("user", "pass"));
        assert_eq!(line("\u{200b}gate.example.net:30\u{200b}").host, "gate.example.net");
        assert_eq!(line("\u{feff}socks5://1.2.3.4:1080").scheme, Some(Scheme::Socks5));
        assert!(parse("\u{feff}").is_err(), "a lone mark is an empty line");
    }

    /// A numeric password made the login-first shape parse as host-first:
    /// `user1:12345:gate.example.com:8000` dialled a proxy called `user1`.
    #[test]
    fn a_numeric_password_never_turns_the_login_into_the_host() {
        let l = line("user1:12345:gate.example.com:8000");
        assert_eq!((l.host.as_str(), l.port), ("gate.example.com", 8000));
        assert_eq!(l.auth, auth("user1", "12345"));
        let l = line("user1:12345:198.51.100.7:8080");
        assert_eq!((l.host.as_str(), l.port), ("198.51.100.7", 8080));
        assert_eq!(l.auth, auth("user1", "12345"));
        // The seller shape with a numeric login and password is untouched.
        let l = line("gate.example.com:8000:12345:67890");
        assert_eq!((l.host.as_str(), l.port), ("gate.example.com", 8000));
        assert_eq!(l.auth, auth("12345", "67890"));
        let l = line("gate.example.com:8000:user1:12345");
        assert_eq!(l.host, "gate.example.com");
        assert_eq!(l.auth, auth("user1", "12345"));
        // A tie keeps the seller convention (host first).
        let l = line("squid:3128:user:1234");
        assert_eq!((l.host.as_str(), l.port), ("squid", 3128));
        // The same ambiguity through the tokeniser.
        let l = line("user1 12345 gate.example.com 8000");
        assert_eq!((l.host.as_str(), l.port), ("gate.example.com", 8000));
        assert_eq!(l.auth, auth("user1", "12345"));
    }

    /// The list every parser is held to: this one, the extension's line.js and
    /// the desktop app read each line of tests/fixtures/proxy-lines.json the
    /// same way, or refuse it.
    #[test]
    fn the_shared_corpus() {
        let corpus: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../tests/fixtures/proxy-lines.json")).expect("the corpus is JSON");
        for case in &corpus {
            let input = case["line"].as_str().expect("every case has a line");
            let got = parse(input);
            if let Some(want) = case.get("error") {
                let e = got.expect_err(&format!("{input:?} should be refused ({})", case["why"]));
                let fragment = want.as_str().unwrap_or_default();
                assert!(
                    e.0.contains(fragment),
                    "{input:?}: {e} (expected to mention {fragment:?})"
                );
                continue;
            }
            let l = got.unwrap_or_else(|e| panic!("{input:?} ({}) failed: {e}", case["why"]));
            assert_eq!(l.host, case["host"].as_str().unwrap(), "{input:?} host");
            assert_eq!(u64::from(l.port), case["port"].as_u64().unwrap(), "{input:?} port");
            let want_auth = case.get("user").map(|u| {
                (
                    u.as_str().unwrap().to_string(),
                    case["pass"].as_str().unwrap_or_default().to_string(),
                )
            });
            assert_eq!(l.auth, want_auth, "{input:?} login");
            let want_scheme = case.get("scheme").and_then(|s| s.as_str()).map(|s| match s {
                "http" => Scheme::Http,
                "socks4" => Scheme::Socks4,
                "socks5" => Scheme::Socks5,
                other => panic!("unknown scheme {other} in the corpus"),
            });
            assert_eq!(l.scheme, want_scheme, "{input:?} scheme");
        }
        assert!(corpus.len() >= 90, "the corpus shrank to {} cases", corpus.len());
    }

    #[test]
    fn a_password_with_a_space_survives_the_colon_shape() {
        assert_eq!(line("1.2.3.4:8080:user:open sesame").auth, auth("user", "open sesame"));
        // Space-separated fields still tokenise when there is no colon shape.
        assert_eq!(line("1.2.3.4 8080 user pass").auth, auth("user", "pass"));
    }
}
