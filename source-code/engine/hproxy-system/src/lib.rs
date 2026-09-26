//! The system proxy setting, read, set and put back exactly as found.
//!
//! "Connect" means two things: run the relay, and point the operating system's
//! proxy setting at it so every program that honours that setting (browsers,
//! most desktop software) goes through the proxy without typing anything.
//! "Disconnect" must leave the machine exactly as it was, which is why every
//! change starts with a [`Snapshot`] of the previous state and ends with
//! [`restore`].
//!
//! What each platform can do:
//!
//! - **Windows**: the per-user Internet Settings key, plus the WinINET refresh
//!   call so running programs notice. No prompt, no elevation.
//! - **GNOME** (and everything that reads its settings): `gsettings`. No prompt.
//! - **macOS**: `networksetup`, which needs administrator rights on most
//!   versions. Attempted; a refusal comes back as a clear error with the
//!   manual steps, never as a silent no-op.
//! - **Everything else**: [`Support::Manual`] with the address to paste.

use serde::{Deserialize, Serialize};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

/// What the OS proxy setting looks like right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProxySetting {
    pub enabled: bool,
    /// `host:port`, or a Windows-style per-scheme list, exactly as stored.
    pub server: Option<String>,
    /// Addresses that bypass the proxy, exactly as stored.
    pub bypass: Option<String>,
}

impl ProxySetting {
    /// True when the setting points at `host:port`.
    pub fn points_at(&self, host: &str, port: u16) -> bool {
        self.enabled
            && self
                .server
                .as_deref()
                .is_some_and(|s| s.contains(&format!("{host}:{port}")))
    }
}

/// The state before we touched it, so it can be put back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub before: ProxySetting,
    /// What we set, so a restore can tell whether the setting is still ours or
    /// the user changed it underneath us (in which case we leave it alone).
    pub ours: ProxySetting,
    #[serde(default)]
    pub platform: String,
}

/// Whether this machine's system proxy can be switched from here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Support {
    /// Set and restored automatically.
    Automatic { how: String },
    /// Not from here; the person pastes the address themselves.
    Manual { why: String, steps: String },
}

pub fn support() -> Support {
    platform::support()
}

/// The current setting.
pub fn current() -> Result<ProxySetting, String> {
    platform::current()
}

/// Point the system at `host:port` for HTTP and HTTPS, remembering what was
/// there.
pub fn set(host: &str, port: u16) -> Result<Snapshot, String> {
    let before = platform::current()?;
    platform::set(host, port)?;
    let ours = platform::current()?;
    Ok(Snapshot {
        before,
        ours,
        platform: std::env::consts::OS.to_string(),
    })
}

/// Put the setting back. If the setting no longer looks like ours (the user
/// changed it while connected) it is left alone, because overwriting a choice
/// they made deliberately is worse than leaving a proxy they set.
pub fn restore(snapshot: &Snapshot) -> Result<RestoreOutcome, String> {
    let now = platform::current()?;
    if now != snapshot.ours {
        return Ok(RestoreOutcome::LeftAlone { now });
    }
    platform::apply(&snapshot.before)?;
    Ok(RestoreOutcome::Restored)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RestoreOutcome {
    Restored,
    /// The setting had been changed by someone else since we set it.
    LeftAlone {
        now: ProxySetting,
    },
}

/// The platform module in use, one name for the cfg mess.
mod platform {
    #[cfg(windows)]
    pub use crate::windows::*;

    #[cfg(target_os = "macos")]
    pub use crate::macos::*;

    #[cfg(target_os = "linux")]
    pub use crate::linux::*;

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    pub fn support() -> crate::Support {
        crate::Support::Manual {
            why: "this operating system's proxy setting cannot be switched from here".into(),
            // The last sentence matters most: the phone keeps pointing at the
            // relay after the app is gone, and then pages stop loading.
            steps: "On a phone: open the Wi-Fi settings, edit the network you are on, set the proxy to Manual with host 127.0.0.1 and the port shown here, no username or password. Apps that follow the Wi-Fi proxy then go through the relay while this app is open. When you disconnect, set the proxy back to None, or pages stop loading.".into(),
        }
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    pub fn current() -> Result<crate::ProxySetting, String> {
        Err("not supported on this operating system".into())
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    pub fn set(_host: &str, _port: u16) -> Result<(), String> {
        Err("not supported on this operating system".into())
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    pub fn apply(_s: &crate::ProxySetting) -> Result<(), String> {
        Err("not supported on this operating system".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points_at_reads_a_plain_and_a_windows_per_scheme_value() {
        let plain = ProxySetting {
            enabled: true,
            server: Some("127.0.0.1:8080".into()),
            bypass: None,
        };
        assert!(plain.points_at("127.0.0.1", 8080));
        assert!(!plain.points_at("127.0.0.1", 8081));
        let per_scheme = ProxySetting {
            enabled: true,
            server: Some("http=127.0.0.1:8080;https=127.0.0.1:8080".into()),
            bypass: None,
        };
        assert!(per_scheme.points_at("127.0.0.1", 8080));
        let off = ProxySetting {
            enabled: false,
            server: Some("127.0.0.1:8080".into()),
            bypass: None,
        };
        assert!(!off.points_at("127.0.0.1", 8080));
    }

    #[test]
    fn a_snapshot_round_trips_through_json() {
        let s = Snapshot {
            before: ProxySetting {
                enabled: false,
                server: None,
                bypass: Some("<local>".into()),
            },
            ours: ProxySetting {
                enabled: true,
                server: Some("127.0.0.1:8080".into()),
                bypass: Some("<local>".into()),
            },
            platform: "windows".into(),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(serde_json::from_str::<Snapshot>(&json).unwrap(), s);
    }
}
