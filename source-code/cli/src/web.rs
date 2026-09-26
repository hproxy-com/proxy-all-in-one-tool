//! The commands that read hproxy.com rather than the network at large:
//! `hproxy list` (the live free list) and `hproxy ip` (where an address is).

use std::io::Write;
use std::time::Duration;

use hproxy_api::free_list::{self, ListQuery};

use crate::check::geo_client;
use crate::Outcome;

#[derive(Debug)]
pub struct ListArgs {
    pub query: ListQuery,
    pub json: bool,
}

pub fn parse_list_args(argv: &[String]) -> Result<ListArgs, String> {
    let mut a = ListArgs {
        query: ListQuery {
            limit: 25,
            ..Default::default()
        },
        json: false,
    };
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => a.json = true,
            "--country" => a.query.country = Some(it.next().ok_or("--country needs a code, e.g. DE")?.clone()),
            "--protocol" | "-p" => {
                a.query.protocol = Some(
                    it.next()
                        .ok_or("--protocol needs http, https, socks4 or socks5")?
                        .clone(),
                )
            }
            "--anonymity" => {
                a.query.anonymity = Some(
                    it.next()
                        .ok_or("--anonymity needs elite, anonymous or transparent")?
                        .clone(),
                )
            }
            "--limit" | "-n" => {
                a.query.limit = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .filter(|n| *n >= 1)
                    .ok_or("--limit needs a number of at least 1")?;
            }
            other => return Err(crate::hint::unknown_option("list", other, crate::hint::LIST_OPTIONS)),
        }
    }
    // Checked here so a typo fails before the network does.
    a.query.to_query()?;
    Ok(a)
}

/// `hproxy list`: one `ip:port` per line, ready for `| hproxy check`.
pub async fn list(argv: &[String]) -> Outcome {
    let a = match parse_list_args(argv) {
        Ok(a) => a,
        Err(e) => return Outcome::Error(e),
    };
    let client = hproxy_api::http_client("hproxy-cli", Duration::from_secs(20));
    let rows = match free_list::fetch(&client, free_list::DEFAULT_LIST_API, &a.query).await {
        Ok(r) => r,
        Err(e) => return Outcome::Error(e),
    };
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for r in &rows {
        let line = if a.json {
            serde_json::to_string(r).unwrap_or_default()
        } else {
            r.line()
        };
        if writeln!(out, "{line}").is_err() {
            break;
        }
    }
    if rows.is_empty() {
        eprintln!("no free proxy matches those filters right now");
        return Outcome::NoneWorking;
    }
    Outcome::Ok
}

/// `hproxy ip <address...>`: the lookup's own answer, as JSON.
pub async fn ip(argv: &[String]) -> Outcome {
    let ips: Vec<String> = argv.iter().filter(|a| !a.starts_with('-')).cloned().collect();
    if let Some(flag) = argv.iter().find(|a| a.starts_with('-')) {
        return Outcome::Error(crate::hint::unknown_option("ip", flag, crate::hint::IP_OPTIONS));
    }
    match geo_client().lookup(&ips).await {
        Ok(v) => {
            println!("{v}");
            Outcome::Ok
        }
        Err(e) => Outcome::Error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn list_flags_are_read_and_checked_before_the_network() {
        let a = parse_list_args(&argv("--country de -p socks5 --limit 5 --json")).unwrap();
        assert_eq!(a.query.country.as_deref(), Some("de"));
        assert_eq!(a.query.protocol.as_deref(), Some("socks5"));
        assert_eq!(a.query.limit, 5);
        assert!(a.json);
        assert!(parse_list_args(&argv("--country Germany")).is_err());
        assert!(parse_list_args(&argv("--limit 0")).is_err());
        assert!(parse_list_args(&argv("--bogus")).is_err());
    }
}
