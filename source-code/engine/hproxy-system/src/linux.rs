//! Linux: GNOME's `gsettings`, which GNOME, Cinnamon, Budgie and most GTK
//! programs read, and which needs no prompt. Anything else (KDE, a bare window
//! manager, a server) gets the manual steps.

use crate::{ProxySetting, Support};
use std::process::Command;

fn gsettings(args: &[&str]) -> Result<String, String> {
    let out = Command::new("gsettings")
        .args(args)
        .output()
        .map_err(|e| format!("gsettings is not available: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "gsettings {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn has_gsettings() -> bool {
    Command::new("gsettings")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn support() -> Support {
    if has_gsettings() {
        Support::Automatic {
            how: "GNOME network proxy setting (gsettings)".into(),
        }
    } else {
        Support::Manual {
            why: "this desktop does not use GNOME's settings, so the proxy cannot be switched from here".into(),
            steps: "Open your desktop's network or proxy settings and set the HTTP and HTTPS proxy to the listen address, with no username or password. Terminals read http_proxy and https_proxy environment variables instead.".into(),
        }
    }
}

fn unquote(s: &str) -> String {
    s.trim().trim_matches('\'').to_string()
}

pub fn current() -> Result<ProxySetting, String> {
    let mode = unquote(&gsettings(&["get", "org.gnome.system.proxy", "mode"])?);
    let host = unquote(&gsettings(&["get", "org.gnome.system.proxy.http", "host"])?);
    let port = gsettings(&["get", "org.gnome.system.proxy.http", "port"])?;
    let ignore = gsettings(&["get", "org.gnome.system.proxy", "ignore-hosts"])?;
    let server = if host.is_empty() {
        None
    } else {
        Some(format!("{host}:{}", port.trim()))
    };
    Ok(ProxySetting {
        enabled: mode == "manual",
        server,
        bypass: Some(ignore),
    })
}

pub fn set(host: &str, port: u16) -> Result<(), String> {
    for schema in ["org.gnome.system.proxy.http", "org.gnome.system.proxy.https"] {
        gsettings(&["set", schema, "host", host])?;
        gsettings(&["set", schema, "port", &port.to_string()])?;
    }
    gsettings(&["set", "org.gnome.system.proxy", "mode", "manual"])?;
    Ok(())
}

pub fn apply(s: &ProxySetting) -> Result<(), String> {
    if let Some(server) = &s.server {
        if let Some((host, port)) = server.rsplit_once(':') {
            for schema in ["org.gnome.system.proxy.http", "org.gnome.system.proxy.https"] {
                gsettings(&["set", schema, "host", host])?;
                gsettings(&["set", schema, "port", port])?;
            }
        }
    }
    if let Some(ignore) = &s.bypass {
        gsettings(&["set", "org.gnome.system.proxy", "ignore-hosts", ignore])?;
    }
    gsettings(&[
        "set",
        "org.gnome.system.proxy",
        "mode",
        if s.enabled { "manual" } else { "none" },
    ])?;
    Ok(())
}
