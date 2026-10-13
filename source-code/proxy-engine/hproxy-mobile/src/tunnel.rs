//! The phone's VPN, on the Rust side: the descriptor Android handed the app
//! (HProxyVpnService.kt) runs through the tunnel (hproxy-tunnel), with the
//! firewall as its gate and the relay, when a proxy is connected, as the way
//! out for everything the gate sends through the proxy.
//!
//! The app opens the VPN again whenever the set of apps in it changes. Only
//! the rules changed: the new descriptor takes over in the running tunnel
//! (`swap`), and open connections carry on. A proxy connected or
//! disconnected: a new tunnel (`start`), because the way out changed.

use std::os::fd::{FromRawFd, OwnedFd};
use std::sync::Arc;

use hproxy_tunnel::{Exits, Gate};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::engine::Engine;

pub struct Running {
    stop: Option<oneshot::Sender<()>>,
    swaps: mpsc::Sender<OwnedFd>,
    task: JoinHandle<()>,
}

/// Take over `fd` (Android detached it for this app; nobody else holds it).
///
/// # Safety
///
/// The caller hands over a descriptor it owns and will not use or close
/// again.
pub unsafe fn owned(fd: i32) -> Result<OwnedFd, String> {
    if fd < 0 {
        return Err("Android gave no VPN to carry the traffic".into());
    }
    Ok(OwnedFd::from_raw_fd(fd))
}

/// A new tunnel on `fd`, replacing the one running, if any. `through_proxy`:
/// the gate may send connections to the relay (a proxy is connected); off,
/// only the firewall runs and nothing is ever sent towards a proxy, even one
/// still disconnecting.
pub fn start(e: &'static Engine, fd: OwnedFd, through_proxy: bool) {
    stop(e);
    let gate: Arc<dyn Gate> = e.firewall.clone();
    let exits = Exits {
        relay: if through_proxy { e.connection.listen() } else { None },
        gate,
    };
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let (swaps_tx, swaps_rx) = mpsc::channel::<OwnedFd>(4);
    let events = Arc::clone(&e.events);
    let task = e.rt.spawn(async move {
        let stopped = std::sync::atomic::AtomicBool::new(false);
        let r = hproxy_tunnel::fd::run_with(fd, exits, swaps_rx, async {
            let _ = stop_rx.await;
            stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        })
        .await;
        if !stopped.load(std::sync::atomic::Ordering::SeqCst) {
            // Ended without being asked: Android took the VPN back, or the
            // descriptor failed. The app says so and tidies up.
            let why = match r {
                Err(e) => e.to_string(),
                Ok(()) => "the VPN closed".into(),
            };
            log::warn!("tunnel: ended by itself: {why}");
            events.emit("tunnel", serde_json::json!({ "up": false, "why": why }));
        }
    });
    *e.tunnel.lock().unwrap_or_else(|p| p.into_inner()) = Some(Running {
        stop: Some(stop_tx),
        swaps: swaps_tx,
        task,
    });
    log::info!(
        "tunnel: up, {}",
        if through_proxy {
            "through the proxy"
        } else {
            "the firewall alone"
        }
    );
}

/// The running tunnel carries on through `fd`.
pub fn swap(e: &'static Engine, fd: OwnedFd) -> Result<(), String> {
    let guard = e.tunnel.lock().unwrap_or_else(|p| p.into_inner());
    let r = guard.as_ref().ok_or("no VPN is running to carry on")?;
    r.swaps
        .try_send(fd)
        .map_err(|_| "the VPN could not take the new descriptor".to_string())
}

/// End the tunnel: its descriptor closes with it.
pub fn stop(e: &'static Engine) {
    let running = e.tunnel.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(mut r) = running {
        if let Some(s) = r.stop.take() {
            let _ = s.send(());
        }
        let _ = e.rt.block_on(&mut r.task);
        log::info!("tunnel: down");
    }
}
