//! Windows: the per-user Internet Settings key, the same values the Settings
//! app writes, plus the WinINET refresh so programs already running pick the
//! change up without a restart.
//!
//! No elevation: `HKEY_CURRENT_USER` is the user's own. The key path is a
//! parameter so the tests write under a scratch key and never touch the real
//! setting on the machine running them.

use crate::{ProxySetting, Support};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

pub const INTERNET_SETTINGS: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

/// What Windows itself writes when a person ticks "Don't use the proxy server
/// for local addresses".
const DEFAULT_BYPASS: &str = "<local>";

pub fn support() -> Support {
    Support::Automatic {
        how: "Windows proxy setting (Settings > Network & Internet > Proxy)".into(),
    }
}

pub fn current() -> Result<ProxySetting, String> {
    read(INTERNET_SETTINGS)
}

pub fn set(host: &str, port: u16) -> Result<(), String> {
    write(
        INTERNET_SETTINGS,
        &ProxySetting {
            enabled: true,
            server: Some(format!("{host}:{port}")),
            bypass: Some(DEFAULT_BYPASS.into()),
        },
    )?;
    refresh();
    Ok(())
}

pub fn apply(s: &ProxySetting) -> Result<(), String> {
    write(INTERNET_SETTINGS, s)?;
    refresh();
    Ok(())
}

pub(crate) fn read(path: &str) -> Result<ProxySetting, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(path, KEY_READ) {
        Ok(k) => k,
        // No key at all reads as "no proxy configured", which is what Windows
        // itself assumes.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ProxySetting::default()),
        Err(e) => return Err(format!("could not read the Internet Settings key: {e}")),
    };
    let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
    let server: Option<String> = key.get_value::<String, _>("ProxyServer").ok().filter(|s| !s.is_empty());
    let bypass: Option<String> = key
        .get_value::<String, _>("ProxyOverride")
        .ok()
        .filter(|s| !s.is_empty());
    Ok(ProxySetting {
        enabled: enabled != 0,
        server,
        bypass,
    })
}

pub(crate) fn write(path: &str, s: &ProxySetting) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey_with_flags(path, KEY_READ | KEY_WRITE)
        .map_err(|e| format!("could not open the Internet Settings key for writing: {e}"))?;
    key.set_value("ProxyEnable", &(s.enabled as u32))
        .map_err(|e| format!("could not write ProxyEnable: {e}"))?;
    match &s.server {
        Some(v) => key
            .set_value("ProxyServer", v)
            .map_err(|e| format!("could not write ProxyServer: {e}"))?,
        None => {
            let _ = key.delete_value("ProxyServer");
        }
    }
    match &s.bypass {
        Some(v) => key
            .set_value("ProxyOverride", v)
            .map_err(|e| format!("could not write ProxyOverride: {e}"))?,
        None => {
            let _ = key.delete_value("ProxyOverride");
        }
    }
    Ok(())
}

/// Tell WinINET, and through it every program using the system setting, that
/// the setting changed. Without this a browser already open keeps the old
/// value until it restarts.
fn refresh() {
    use windows_sys::Win32::Networking::WinInet::{
        InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
    };
    // SAFETY: both calls take a null handle and no buffer, which is the
    // documented way to broadcast a settings change; there is nothing to
    // dereference and nothing to free.
    unsafe {
        InternetSetOptionW(
            std::ptr::null_mut(),
            INTERNET_OPTION_SETTINGS_CHANGED,
            std::ptr::null(),
            0,
        );
        InternetSetOptionW(std::ptr::null_mut(), INTERNET_OPTION_REFRESH, std::ptr::null(), 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch key of our own, so the test never touches the real setting.
    const SCRATCH: &str = r"Software\HProxy\test-internet-settings";

    #[test]
    fn writes_reads_back_and_restores_under_a_scratch_key() {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(SCRATCH);

        // Nothing there yet reads as "no proxy".
        assert_eq!(read(SCRATCH).unwrap(), ProxySetting::default());

        let before = ProxySetting {
            enabled: false,
            server: Some("old.example:3128".into()),
            bypass: None,
        };
        write(SCRATCH, &before).unwrap();
        assert_eq!(read(SCRATCH).unwrap(), before);

        let ours = ProxySetting {
            enabled: true,
            server: Some("127.0.0.1:8080".into()),
            bypass: Some(DEFAULT_BYPASS.into()),
        };
        write(SCRATCH, &ours).unwrap();
        let now = read(SCRATCH).unwrap();
        assert_eq!(now, ours);
        assert!(now.points_at("127.0.0.1", 8080));

        // Restoring puts every value back, including removing the bypass we added.
        write(SCRATCH, &before).unwrap();
        assert_eq!(read(SCRATCH).unwrap(), before);

        let _ = hkcu.delete_subkey_all(SCRATCH);
    }
}
