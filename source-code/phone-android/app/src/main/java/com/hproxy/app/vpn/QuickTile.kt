package com.hproxy.app.vpn

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.hproxy.app.MainActivity
import com.hproxy.app.R
import com.hproxy.app.state.AppState

/**
 * HProxy in the phone's quick settings: on while connected, a tap disconnects; off, a tap connects
 * what the switch connects (yours used last, never a free proxy). The engine lives with the app,
 * not the screen, so the tile connects without opening it; it opens the app when none of yours is
 * there yet or the VPN was never allowed.
 */
class QuickTile : TileService() {
    override fun onStartListening() {
        show()
    }

    override fun onClick() {
        AppState.start(applicationContext)
        if (AppState.wanted) {
            AppState.disconnect()
        } else if (vpnAllowed() && AppState.library.value.switchTo != null) {
            val intent = Intent(this, HProxyVpnService::class.java).setAction(HProxyVpnService.ACTION_CONNECT)
            try {
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
            } catch (e: Exception) {
                // Android 12 and later can refuse a start from the background: the app connects.
                openApp()
            }
        } else {
            openApp()
        }
        show()
    }

    /** The VPN was allowed before (a few phones throw here: then the app asks, or says why not). */
    private fun vpnAllowed(): Boolean = try {
        VpnService.prepare(this) == null
    } catch (e: Exception) {
        false
    }

    private fun show() {
        val tile = qsTile ?: return
        tile.state = if (AppState.wanted) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = getString(R.string.app_name)
        tile.updateTile()
    }

    /** Android 14 and newer take only the PendingIntent; the Intent is for the older ones, where
     *  it is the only way (lint flags the old call even behind the version check). */
    @SuppressLint("StartActivityAndCollapseDeprecated")
    @Suppress("DEPRECATION")
    private fun openApp() {
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
        } else {
            startActivityAndCollapse(intent)
        }
    }
}
