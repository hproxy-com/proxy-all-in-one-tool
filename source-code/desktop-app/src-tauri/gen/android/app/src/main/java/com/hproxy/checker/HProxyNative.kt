package com.hproxy.checker

import android.util.Log

/**
 * Calls from Android into the app's Rust side (desktop-app/src-tauri/src/vpn.rs, the
 * `Java_com_hproxy_checker_HProxyNative_*` functions) for what happens outside the window: the
 * notification's Next IP and Disconnect, the quick tile, and Android taking the VPN back.
 *
 * Rust lives in the app's library, which the window loads. `ready` turns true once Rust has
 * started (vpn.rs, when its plugin loads); before that, or in a process Android started without
 * the window, every call is skipped instead of crashing on a function that is not there yet.
 */
object HProxyNative {
  @Volatile var ready = false

  @JvmStatic private external fun nextIp()
  @JvmStatic private external fun disconnect()
  @JvmStatic private external fun connect()
  @JvmStatic private external fun revoked()

  fun nextIpSafely() = call("next IP") { nextIp() }
  fun disconnectSafely() = call("disconnect") { disconnect() }
  fun connectSafely(): Boolean = call("connect") { connect() }
  fun revokedSafely() = call("revoked") { revoked() }

  private inline fun call(what: String, f: () -> Unit): Boolean {
    if (!ready) return false
    return try {
      f()
      true
    } catch (e: UnsatisfiedLinkError) {
      Log.w("HProxyNative", "$what: the app's library is not loaded", e)
      false
    }
  }
}
