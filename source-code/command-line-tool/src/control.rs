//! `hproxy new-ip`: switch a running connection to its next proxy, through the
//! connection's own page (hproxy-relay, control.rs). Also how `status` asks a
//! running connection which proxy it is on right now.
//!
//! Plain HTTP on the connection's own port, the same request any script in
//! any language makes. So the command and a script can never disagree.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::connect::running_now;
use crate::Outcome;

/// A switch to a free exit searches the pool for one that works, which may
/// take the pool's whole search time.
const SWITCH_WAIT: Duration = Duration::from_secs(hproxy_relay::pool::SEARCH_DEADLINE.as_secs() + 30);

/// Where a connection's pages are, and the login to send, if any.
#[derive(Debug, PartialEq, Eq)]
struct Target {
    addr: String,
    login: Option<(String, String)>,
}

/// An address a connection listens on, as this machine reaches it: one on
/// every address (0.0.0.0, ::) through loopback.
pub fn reachable(listening: &str) -> String {
    match listening.parse::<SocketAddr>() {
        Ok(a) if a.ip().is_unspecified() => {
            let lo: IpAddr = if a.is_ipv4() {
                Ipv4Addr::LOCALHOST.into()
            } else {
                Ipv6Addr::LOCALHOST.into()
            };
            SocketAddr::new(lo, a.port()).to_string()
        }
        _ => listening.to_string(),
    }
}

/// What the person typed: a port (`8080`), an address (`127.0.0.1:8080`,
/// `nas.local:8080`), or either with a login (`http://name:password@nas:8080`)
/// for the connection other devices use.
fn parse_target(word: &str) -> Result<Target, String> {
    if !word.is_empty() && word.bytes().all(|b| b.is_ascii_digit()) {
        let port: u16 = word.parse().map_err(|_| format!("{word} is not a port (1 to 65535)"))?;
        return Ok(Target {
            addr: format!("127.0.0.1:{port}"),
            login: None,
        });
    }
    let rest = word.split_once("://").map_or(word, |(_, r)| r);
    let authority = rest.split('/').next().unwrap_or(rest);
    let (login, addr) = match authority.rsplit_once('@') {
        Some((userinfo, addr)) => {
            let (name, password) = userinfo.split_once(':').unwrap_or((userinfo, ""));
            (Some((name.to_string(), password.to_string())), addr)
        }
        None => (None, authority),
    };
    let port = match addr.strip_prefix('[') {
        Some(v6) => v6.split_once("]:").map(|(_, p)| p),
        None => addr.rsplit_once(':').map(|(_, p)| p),
    };
    if port.is_none_or(|p| p.parse::<u16>().is_err()) {
        return Err(format!(
            "`{word}` names no port. Write the port alone (8080) or address:port (127.0.0.1:8080)"
        ));
    }
    Ok(Target {
        addr: addr.to_string(),
        login,
    })
}

/// The connection to switch: the one named, else the one running here.
fn pick(word: Option<&str>) -> Result<Target, String> {
    let running = running_now();
    if let Some(word) = word {
        // A connection running here, named by its port or address: where it really listens.
        if let Some(r) = running.iter().find(|r| crate::connect::is_the_one(&r.listening, word)) {
            return Ok(Target {
                addr: reachable(&r.listening),
                login: None,
            });
        }
        return parse_target(word);
    }
    match running.as_slice() {
        [one] => Ok(Target {
            addr: reachable(&one.listening),
            login: None,
        }),
        // None in the background: one in a terminal, a container or a service
        // listens on the default address, when one runs at all.
        [] => Ok(Target {
            addr: hproxy_relay::DEFAULT_LISTEN.to_string(),
            login: None,
        }),
        many => Err(format!(
            "{} connections run here: {}. Name one, for example `hproxy new-ip {}`",
            many.len(),
            many.iter().map(|r| r.listening.as_str()).collect::<Vec<_>>().join(", "),
            many[0].listening.rsplit(':').next().unwrap_or("8080"),
        )),
    }
}

/// One request to a connection's page: the answer's status code and its JSON.
pub async fn ask(
    addr: &str,
    method: &str,
    path: &str,
    login: Option<&(String, String)>,
    wait: Duration,
) -> Result<(u16, Value), String> {
    let mut s = match tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(addr)).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("nothing answers on {addr}: {e}")),
        Err(_) => return Err(format!("nothing answers on {addr}")),
    };
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nUser-Agent: hproxy/{}\r\nAccept: application/json\r\nConnection: close\r\n",
        env!("CARGO_PKG_VERSION")
    );
    if let Some((name, password)) = login {
        request.push_str(&format!(
            "Authorization: {}\r\n",
            hproxy_relay::upstream::basic(name, password)
        ));
    }
    if method == "POST" {
        request.push_str("Content-Length: 0\r\n");
    }
    request.push_str("\r\n");
    s.write_all(request.as_bytes())
        .await
        .map_err(|e| format!("{addr}: {e}"))?;
    let mut raw = Vec::new();
    match tokio::time::timeout(wait, (&mut s).take(1 << 20).read_to_end(&mut raw)).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) if raw.is_empty() => return Err(format!("{addr} closed without an answer: {e}")),
        // A reset after the answer: the answer is what counts.
        Ok(Err(_)) => {}
        Err(_) => return Err(format!("{addr} gave no answer within {} s", wait.as_secs())),
    }
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| format!("{addr} closed without an answer"))?;
    let code = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| format!("{addr} answers, but not over HTTP"))?;
    match serde_json::from_str::<Value>(body.trim()) {
        Ok(v) if v.get("ok").is_some() => Ok((code, v)),
        _ => Err(format!(
            "{addr} answers, but has no control pages: an hproxy from before them, or another program. \
             Restart the connection with this hproxy"
        )),
    }
}

/// What a running connection says about itself now (the proxy in use, the
/// counts), or `None` from one that cannot say: an hproxy from before the pages.
pub async fn live(listening: &str) -> Option<Value> {
    let (code, body) = ask(
        &reachable(listening),
        "GET",
        "/hproxy/status",
        None,
        Duration::from_secs(2),
    )
    .await
    .ok()?;
    (code == 200).then_some(body)
}

/// `hproxy new-ip [ADDRESS] [--member N] [--probe] [--json]`.
pub async fn new_ip(argv: &[String]) -> Outcome {
    let mut word: Option<&str> = None;
    let mut member: Option<usize> = None;
    let (mut as_json, mut probe) = (false, false);
    let mut args = argv.iter();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--json" => as_json = true,
            "--probe" => probe = true,
            "--member" => {
                match args.next().map(|v| v.parse::<usize>()) {
                    Some(Ok(n)) if n >= 1 => member = Some(n),
                    _ => return Outcome::Error(
                        "--member takes a number from 1: `hproxy new-ip --member 3` switches to proxy 3 of your list"
                            .into(),
                    ),
                }
            }
            other if other.starts_with('-') => {
                return Outcome::Error(crate::hint::unknown_option(
                    "new-ip",
                    other,
                    crate::hint::NEW_IP_OPTIONS,
                ))
            }
            other => {
                if word.is_some() {
                    return Outcome::Error("new-ip takes one address at most, for example `hproxy new-ip 8080`".into());
                }
                word = Some(other);
            }
        }
    }
    let target = match pick(word) {
        Ok(t) => t,
        Err(e) => return Outcome::Error(e),
    };
    if word.is_none() && !crate::connect::answers(&target.addr) {
        return Outcome::Error(
            "nothing is running here. Start a connection that can rotate, for example \
             `hproxy connect --file proxies.txt --background`. One that runs on another port: \
             `hproxy new-ip 9000`"
                .into(),
        );
    }
    let path = match member {
        Some(n) => format!("/hproxy/new-ip?member={n}"),
        None => "/hproxy/new-ip".to_string(),
    };
    let (code, mut body) = match ask(&target.addr, "POST", &path, target.login.as_ref(), SWITCH_WAIT).await {
        Ok(v) => v,
        Err(e) => return Outcome::Error(e),
    };
    if !(200..300).contains(&code) || body["ok"] != true {
        let why = body["error"].as_str().unwrap_or("the connection refused the switch");
        return Outcome::Error(why.to_string());
    }
    // Asking the world through it costs a round trip, so only when asked.
    let exit = if probe {
        crate::probe::through(&target.addr).await
    } else {
        None
    };
    if as_json {
        if let Some(e) = &exit {
            body["exit_ip"] = json!(e.exit_ip);
            body["country_code"] = json!(e.country_code);
            body["latency_ms"] = json!(e.latency_ms);
        }
        println!("{body}");
        return Outcome::Ok;
    }
    let upstream = body["upstream"].as_str().unwrap_or("?");
    match (body["member"].as_u64(), body["members"].as_u64()) {
        (Some(m), Some(n)) => println!("Now on proxy {m} of {n}: {upstream}"),
        _ => println!("Now on {upstream}"),
    }
    if probe {
        match &exit {
            Some(e) => println!(
                "  exit: {} {} {}",
                e.exit_ip.as_deref().unwrap_or("unknown"),
                e.country_code.as_deref().unwrap_or(""),
                e.latency_ms.map(|ms| format!("{ms} ms")).unwrap_or_default()
            ),
            None => println!("  exit: no answer through it yet"),
        }
    }
    Outcome::Ok
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(addr: &str, login: Option<(&str, &str)>) -> Target {
        Target {
            addr: addr.into(),
            login: login.map(|(n, p)| (n.into(), p.into())),
        }
    }

    #[test]
    fn a_port_an_address_or_a_url_with_its_login() {
        assert_eq!(parse_target("8080").unwrap(), target("127.0.0.1:8080", None));
        assert_eq!(parse_target("127.0.0.1:9000").unwrap(), target("127.0.0.1:9000", None));
        assert_eq!(parse_target("nas.local:8080").unwrap(), target("nas.local:8080", None));
        assert_eq!(parse_target("[::1]:8080").unwrap(), target("[::1]:8080", None));
        assert_eq!(
            parse_target("http://name:pass@192.168.1.5:8080/hproxy").unwrap(),
            target("192.168.1.5:8080", Some(("name", "pass")))
        );
        assert!(parse_target("nas.local").is_err());
        assert!(parse_target("99999").is_err());
        assert!(parse_target("http://nas.local/").is_err());
    }

    #[test]
    fn a_connection_on_every_address_is_reached_through_loopback() {
        assert_eq!(reachable("0.0.0.0:8080"), "127.0.0.1:8080");
        assert_eq!(reachable("[::]:8080"), "[::1]:8080");
        assert_eq!(reachable("127.0.0.1:8080"), "127.0.0.1:8080");
        assert_eq!(reachable("192.168.1.5:8080"), "192.168.1.5:8080");
    }
}
