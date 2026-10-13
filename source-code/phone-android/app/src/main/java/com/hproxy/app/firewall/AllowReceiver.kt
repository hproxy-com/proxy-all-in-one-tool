package com.hproxy.app.firewall

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.hproxy.app.state.AppRule
import com.hproxy.app.state.AppState
import com.hproxy.app.state.Settings

/** "Allow" on a blocked app's notification: the app may use the network it tried (both, for a new
 *  app), and the VPN follows at once. */
class AllowReceiver : BroadcastReceiver() {
    companion object {
        const val PKG = "pkg"
        const val NET = "net"
        const val ID = "id"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val pkg = intent.getStringExtra(PKG) ?: return
        AppState.start(context)
        val rule = Settings.rules.value[pkg] ?: AppRule()
        val next = when (intent.getStringExtra(NET)?.let { runCatching { Net.valueOf(it) }.getOrNull() }) {
            Net.Mobile -> rule.copy(mobile = true)
            Net.Wifi, Net.Other -> rule.copy(wifi = true)
            null -> rule.copy(wifi = true, mobile = true)
        }
        Settings.setRule(pkg, next)
        if (Settings.prefs.value.blockNewApps) Settings.knownApps = Settings.knownApps + pkg
        AppState.rulesChanged()
        context.getSystemService(NotificationManager::class.java)?.cancel(intent.getIntExtra(ID, 0))
    }
}
