//! The phone's VPN: on Android, "use for the whole phone" means every app's
//! traffic comes to the relay through a VPN (proxy-engine/hproxy-tunnel). On a
//! computer the system proxy does that job (hproxy-system) and nothing here runs.
//!
//!   connect.rs start_place ─► start(): VpnPlugin.kt asks the person once,
//!   HProxyVpnService.kt opens the VPN and hands over its file descriptor,
//!   and the tunnel runs on it until stop() or until Android takes it back.
//!
//! The notification's Next IP and Disconnect and the quick tile come back
//! through the `Java_com_hproxy_checker_HProxyNative_*` functions below.

use serde::Serialize;

/// What HProxyVpnService.kt opens the VPN with: one place decides the routes,
/// the addresses and the DNS server, and that is the tunnel crate.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Debug, Serialize)]
pub struct StartArgs {
    routes: Vec<String>,
    addresses: Vec<String>,
    dns: String,
    mtu: u16,
    /// What the notification names: the proxy connected through.
    through: String,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn start_args(through: &str) -> StartArgs {
    StartArgs {
        routes: hproxy_tunnel::vpn_routes()
            .into_iter()
            .map(|(ip, len)| format!("{ip}/{len}"))
            .collect(),
        addresses: vec![
            format!("{}/32", hproxy_tunnel::TUN_V4),
            format!("{}/128", hproxy_tunnel::TUN_V6),
        ],
        dns: hproxy_tunnel::DNS_V4.to_string(),
        mtu: hproxy_tunnel::MTU,
        through: through.to_string(),
    }
}

#[cfg(target_os = "android")]
pub mod android {
    use std::ffi::c_void;
    use std::net::SocketAddr;
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, OnceLock};

    use serde::{Deserialize, Serialize};
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Wry};

    struct Vpn(PluginHandle<Wry>);

    /// The app, for calls that come from Android outside the window.
    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// Registered in lib.rs: loads the Kotlin side once, when the app starts.
    pub fn plugin() -> TauriPlugin<Wry> {
        Builder::new("vpn")
            .setup(|app, api| {
                let _ = APP.set(app.clone());
                let handle = api.register_android_plugin("com.hproxy.checker", "VpnPlugin")?;
                app.manage(Vpn(handle));
                Ok(())
            })
            .build()
    }

    /// The VPN while it is up.
    pub struct Running {
        stop: Option<tokio::sync::oneshot::Sender<()>>,
        task: tauri::async_runtime::JoinHandle<()>,
        /// Set when the app ends the VPN; unset, an end means the VPN failed.
        stopping: Arc<AtomicBool>,
    }

    #[derive(Deserialize)]
    struct Started {
        fd: i32,
    }

    /// Opens the VPN and carries every app through the relay on `relay`. Fails
    /// with words for the person when they did not allow it or Android refused.
    pub async fn start(app: &AppHandle, relay: SocketAddr, through: &str) -> Result<Running, String> {
        let vpn = app
            .try_state::<Vpn>()
            .ok_or("the VPN is not available in this copy of the app")?;
        let started: Started = vpn
            .0
            .run_mobile_plugin_async("start", super::start_args(through))
            .await
            .map_err(|e| e.to_string())?;
        if started.fd < 0 {
            return Err("Android gave no VPN to carry the traffic".into());
        }
        // SAFETY: HProxyVpnService detached this descriptor and handed it over;
        // nothing else holds it, so this is its one owner from here on.
        let fd = unsafe { OwnedFd::from_raw_fd(started.fd) };
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let stopping = Arc::new(AtomicBool::new(false));
        let task = {
            let stopping = Arc::clone(&stopping);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = hproxy_tunnel::fd::run(fd, relay, async {
                    let _ = stop_rx.await;
                })
                .await
                {
                    log::error!("vpn: the tunnel could not run: {e}");
                }
                // Ended without being asked: the whole connection goes, so the
                // window never says "connected" while nothing is carried. From
                // its own task: the stop waits for this one to finish.
                if !stopping.load(Ordering::SeqCst) {
                    tauri::async_runtime::spawn(async move { crate::connect::stop_from_outside(&app).await });
                }
            })
        };
        log::info!("vpn: up, every app goes through {relay}");
        Ok(Running {
            stop: Some(stop_tx),
            task,
            stopping,
        })
    }

    /// Ends the VPN: the tunnel closes its descriptor, then the service and
    /// its notification go.
    pub async fn stop(app: &AppHandle, mut running: Running) {
        running.stopping.store(true, Ordering::SeqCst);
        if let Some(stop) = running.stop.take() {
            let _ = stop.send(());
        }
        let _ = running.task.await;
        call(app, "stop", ()).await;
        log::info!("vpn: down");
    }

    /// The notification names what the relay goes through now.
    pub fn through_changed(app: &AppHandle, through: &str) {
        #[derive(Serialize)]
        struct Update {
            through: String,
        }
        let app = app.clone();
        let update = Update {
            through: through.to_string(),
        };
        tauri::async_runtime::spawn(async move { call(&app, "update", update).await });
    }

    async fn call(app: &AppHandle, command: &str, args: impl Serialize) {
        let Some(vpn) = app.try_state::<Vpn>() else { return };
        if let Err(e) = vpn.0.run_mobile_plugin_async::<serde_json::Value>(command, args).await {
            log::warn!("vpn: {command} failed: {e}");
        }
    }

    /// Runs `f` on the app from a call Android made (HProxyNative.kt).
    fn from_android<F, Fut>(f: F)
    where
        F: FnOnce(AppHandle) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        if let Some(app) = APP.get() {
            let app = app.clone();
            tauri::async_runtime::spawn(f(app));
        }
    }

    // The JNI names are the Kotlin class and method: HProxyNative.nextIp() and
    // the rest. Nothing is read from Java, so the two pointers stay unused.

    #[no_mangle]
    pub extern "system" fn Java_com_hproxy_checker_HProxyNative_nextIp(_env: *mut c_void, _class: *mut c_void) {
        from_android(|app| async move { crate::connect::next_ip_from_outside(&app).await });
    }

    #[no_mangle]
    pub extern "system" fn Java_com_hproxy_checker_HProxyNative_disconnect(_env: *mut c_void, _class: *mut c_void) {
        from_android(|app| async move { crate::connect::stop_from_outside(&app).await });
    }

    #[no_mangle]
    pub extern "system" fn Java_com_hproxy_checker_HProxyNative_connect(_env: *mut c_void, _class: *mut c_void) {
        from_android(|app| async move {
            if let Err(e) = crate::connect::connect_picked(&app).await {
                log::warn!("vpn: the quick tile could not connect: {e}");
            }
        });
    }

    /// Android took the VPN back (another VPN app, or the phone's settings):
    /// the descriptor is dead, so the connection ends with it.
    #[no_mangle]
    pub extern "system" fn Java_com_hproxy_checker_HProxyNative_revoked(_env: *mut c_void, _class: *mut c_void) {
        from_android(|app| async move { crate::connect::stop_from_outside(&app).await });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vpn_is_opened_with_the_tunnel_s_own_addresses() {
        let args = start_args("1.2.3.4:8080");
        assert_eq!(args.addresses, ["198.18.0.1/32", "fd00:6870::1/128"]);
        assert_eq!(args.dns, "198.18.0.2");
        assert!(args.routes.contains(&"2000::/3".to_string()));
        assert!(
            args.routes.iter().all(|r| r.contains('/')),
            "every route has its length"
        );
        let json = serde_json::to_value(&args).unwrap();
        for key in ["routes", "addresses", "dns", "mtu", "through"] {
            assert!(json.get(key).is_some(), "VpnPlugin.kt reads {key}");
        }
    }
}
