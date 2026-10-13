package com.hproxy.checker

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * HProxy in the phone's quick settings (pull down from the top): on while connected, a tap
 * disconnects; off, a tap connects to the place picked last, or opens the app when it is not
 * running or nothing is picked yet.
 */
class QuickTile : TileService() {
  override fun onStartListening() {
    show()
  }

  override fun onClick() {
    if (HProxyVpnService.running != null) {
      HProxyNative.disconnectSafely()
    } else if (!HProxyNative.connectSafely()) {
      openApp()
    }
    show()
  }

  private fun show() {
    val tile = qsTile ?: return
    tile.state = if (HProxyVpnService.running != null) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
    tile.label = getString(R.string.app_name)
    tile.updateTile()
  }

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
