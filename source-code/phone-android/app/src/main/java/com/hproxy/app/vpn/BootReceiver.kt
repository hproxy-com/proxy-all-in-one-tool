package com.hproxy.app.vpn

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import com.hproxy.app.state.Settings

/**
 * "Connect on startup": when the phone has started, the place used last connects. After an update
 * of the app, a connection that was on when the update came comes back on: only one of this start
 * of the phone that nothing else ended (Settings.connectedInBoot). Only when the VPN was allowed
 * before (a phone that just started has nobody to ask).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Settings.load(context)
        val wanted = when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> Settings.prefs.value.connectOnStartup
            Intent.ACTION_MY_PACKAGE_REPLACED -> Settings.connectedInBoot.let { it >= 0 && it == Settings.bootCount(context) }
            else -> false
        }
        if (!wanted) return
        // Allowed before: a phone that just started has nobody to ask (a few phones throw here).
        val allowed = try {
            VpnService.prepare(context) == null
        } catch (e: Exception) {
            false
        }
        if (!allowed) return
        val start = Intent(context, HProxyVpnService::class.java).setAction(HProxyVpnService.ACTION_CONNECT)
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(start) else context.startService(start)
        } catch (e: Exception) {
            // Android may refuse a start from here; the person connects when they open the app.
        }
    }
}
