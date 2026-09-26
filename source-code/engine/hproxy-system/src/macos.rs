//! macOS: `networksetup` on the active network service. It needs
//! administrator rights on most versions, so a refusal comes back as an error
//! that carries the manual steps rather than pretending it worked.

use crate::{ProxySetting, Support};
use std::process::Command;

fn networksetup(args: &[&str]) -> Result<String, String> {
    let out = Command::new("networksetup")
        .args(args)
        .output()
        .map_err(|e| format!("networksetup is not available: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "networksetup {} failed: {}",
            args.join(" "),
            if err.is_empty() { text.clone() } else { err }
        ));
    }
    Ok(text)
}

/// The first enabled network service, which is the one the Mac is using.
fn active_service() -> Result<String, String> {
    let list = networksetup(&["-listallnetworkservices"])?;
    list.lines()
        .skip(1)
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('*'))
        .map(str::to_string)
        .ok_or_else(|| "no active network service found".to_string())
}

pub fn support() -> Support {
    Support::Automatic {
        how: "macOS network proxy setting (networksetup, may ask for your password)".into(),
    }
}

fn parse_get(text: &str) -> (bool, Option<String>) {
    let mut enabled = false;
    let mut server = None;
    let mut port = None;
    for line in text.lines() {
        let (k, v) = match line.split_once(':') {
            Some(kv) => kv,
            None => continue,
        };
        match k.trim() {
            "Enabled" => enabled = v.trim().eq_ignore_ascii_case("yes"),
            "Server" => server = Some(v.trim().to_string()).filter(|s| !s.is_empty()),
            "Port" => port = Some(v.trim().to_string()).filter(|p| !p.is_empty() && p != "0"),
            _ => {}
        }
    }
    let joined = match (server, port) {
        (Some(s), Some(p)) => Some(format!("{s}:{p}")),
        (Some(s), None) => Some(s),
        _ => None,
    };
    (enabled, joined)
}

pub fn current() -> Result<ProxySetting, String> {
    let svc = active_service()?;
    let (enabled, server) = parse_get(&networksetup(&["-getwebproxy", &svc])?);
    let bypass = networksetup(&["-getproxybypassdomains", &svc]).ok();
    Ok(ProxySetting {
        enabled,
        server,
        bypass,
    })
}

pub fn set(host: &str, port: u16) -> Result<(), String> {
    let svc = active_service()?;
    let p = port.to_string();
    networksetup(&["-setwebproxy", &svc, host, &p]).map_err(with_manual_steps)?;
    networksetup(&["-setsecurewebproxy", &svc, host, &p]).map_err(with_manual_steps)?;
    Ok(())
}

pub fn apply(s: &ProxySetting) -> Result<(), String> {
    let svc = active_service()?;
    if let Some(server) = &s.server {
        if let Some((host, port)) = server.rsplit_once(':') {
            networksetup(&["-setwebproxy", &svc, host, port]).map_err(with_manual_steps)?;
            networksetup(&["-setsecurewebproxy", &svc, host, port]).map_err(with_manual_steps)?;
        }
    }
    let state = if s.enabled { "on" } else { "off" };
    networksetup(&["-setwebproxystate", &svc, state]).map_err(with_manual_steps)?;
    networksetup(&["-setsecurewebproxystate", &svc, state]).map_err(with_manual_steps)?;
    Ok(())
}

fn with_manual_steps(e: String) -> String {
    format!("{e}. To set it by hand: System Settings > Network > your connection > Details > Proxies, tick Web Proxy (HTTP) and Secure Web Proxy (HTTPS), enter the listen address and port, leave the username and password empty.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_networksetup_output() {
        let (enabled, server) =
            parse_get("Enabled: Yes\nServer: 127.0.0.1\nPort: 8080\nAuthenticated Proxy Enabled: 0\n");
        assert!(enabled);
        assert_eq!(server.as_deref(), Some("127.0.0.1:8080"));
        let (enabled, server) = parse_get("Enabled: No\nServer: \nPort: 0\n");
        assert!(!enabled);
        assert_eq!(server, None);
    }
}
