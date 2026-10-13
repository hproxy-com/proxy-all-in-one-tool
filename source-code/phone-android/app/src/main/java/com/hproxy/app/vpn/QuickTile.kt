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
 * to the place used last. The engine lives with the app, not the screen, so the tile connects
 * without opening it; it opens the app only when nothing was picked yet or the VPN was never
 * allowed.
 */
class QuickTile : TileService() {
    override fun onStartListening() {
        show()
    }

    override fun onClick() {
        AppState.start(applicationContext)
        if (AppState.wanted) {
            AppState.disconnect()
        } else if (VpnService.prepare(this) == null && AppState.library.value.picked != null) {
            val intent = Intent(this, HProxyVpnService::class.java).setAction(HProxyVpnService.ACTION_CONNECT)
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
        } else {
            openApp()
        }
        show()
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
