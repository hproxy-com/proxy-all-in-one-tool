package com.hproxy.checker

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class StartArgs {
  var routes: Array<String> = arrayOf()
  var addresses: Array<String> = arrayOf()
  var dns: String = ""
  var mtu: Int = 1500
  var through: String = ""
}

@InvokeArg
class UpdateArgs {
  var through: String = ""
}

/**
 * The VPN, for Rust (desktop-app/src-tauri/src/vpn.rs): asks the person once to allow it (Android's
 * own "connection request" screen), starts HProxyVpnService and answers with the VPN's file
 * descriptor, which Rust then owns. Loaded by vpn.rs (`register_android_plugin`).
 */
@TauriPlugin
class VpnPlugin(private val activity: Activity) : Plugin(activity) {
  private var waiting: StartArgs? = null

  override fun load(webView: android.webkit.WebView) {
    super.load(webView)
    HProxyNative.ready = true
  }

  @Command
  fun start(invoke: Invoke) {
    val args = invoke.parseArgs(StartArgs::class.java)
    askToShowNotifications()
    // Null when this app may already run a VPN; otherwise the screen that asks.
    val ask = VpnService.prepare(activity)
    if (ask == null) {
      startService(invoke, args)
    } else {
      waiting = args
      startActivityForResult(invoke, ask, "allowed")
    }
  }

  @ActivityCallback
  private fun allowed(invoke: Invoke, result: ActivityResult) {
    val args = waiting
    waiting = null
    if (result.resultCode != Activity.RESULT_OK || args == null) {
      invoke.reject("The VPN was not allowed, so apps cannot go through HProxy. Connect again and tap OK to allow it.")
      return
    }
    startService(invoke, args)
  }

  private fun startService(invoke: Invoke, args: StartArgs) {
    HProxyVpnService.onEstablished = { fd, why ->
      if (fd != null) invoke.resolve(JSObject().put("fd", fd)) else invoke.reject(why ?: "the VPN could not be opened")
    }
    val intent =
      Intent(activity, HProxyVpnService::class.java)
        .setAction(HProxyVpnService.ACTION_START)
        .putExtra(HProxyVpnService.EXTRA_ROUTES, args.routes)
        .putExtra(HProxyVpnService.EXTRA_ADDRESSES, args.addresses)
        .putExtra(HProxyVpnService.EXTRA_DNS, args.dns)
        .putExtra(HProxyVpnService.EXTRA_MTU, args.mtu)
        .putExtra(HProxyVpnService.EXTRA_THROUGH, args.through)
    try {
      // The window is in front (the person just tapped Connect), so a plain start is allowed;
      // the service puts itself in front once the VPN is open.
      activity.startService(intent)
    } catch (e: Exception) {
      HProxyVpnService.onEstablished = null
      invoke.reject("the VPN could not be started: ${e.message}")
    }
  }

  /** The VPN is down (Rust closed it): the service and its notification go too. */
  @Command
  fun stop(invoke: Invoke) {
    if (HProxyVpnService.running != null) {
      activity.startService(Intent(activity, HProxyVpnService::class.java).setAction(HProxyVpnService.ACTION_STOP))
    }
    invoke.resolve()
  }

  /** The notification names the place after a switch or Next IP. */
  @Command
  fun update(invoke: Invoke) {
    val args = invoke.parseArgs(UpdateArgs::class.java)
    if (HProxyVpnService.running != null) {
      activity.startService(
        Intent(activity, HProxyVpnService::class.java)
          .setAction(HProxyVpnService.ACTION_UPDATE)
          .putExtra(HProxyVpnService.EXTRA_THROUGH, args.through)
      )
    }
    invoke.resolve()
  }

  /** Android 13 and later ask before an app shows notifications; the VPN works either way. */
  private fun askToShowNotifications() {
    if (Build.VERSION.SDK_INT < 33) return
    if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7101)
  }
}
