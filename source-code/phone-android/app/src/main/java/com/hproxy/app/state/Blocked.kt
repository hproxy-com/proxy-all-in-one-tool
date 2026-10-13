package com.hproxy.app.state

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.hproxy.app.MainActivity
import com.hproxy.app.R
import com.hproxy.app.firewall.AllowReceiver
import com.hproxy.app.firewall.Firewall
import com.hproxy.app.firewall.Net
import org.json.JSONObject

/**
 * The firewall's word to the person (NetGuard's idea): a blocked app tried to connect, or a new app
 * is blocked until it is allowed. One tap on "Allow" lets it, on the network it tried. Once a minute
 * per app at most (the engine sees to that), and never when "Tell me" is off.
 */
object Blocked {
    private const val CHANNEL = "blocked"
    /** Notice ids: one per app and kind, from the app's user id. */
    private const val TRIED = 1000
    private const val NEW = 200000
    private const val SPAN = 100000

    fun tried(context: Context, e: JSONObject) {
        if (!Settings.prefs.value.tellBlocked) return
        val uid = e.optInt("uid", -1)
        val app = Firewall.installed(context).firstOrNull { it.uid == uid } ?: return
        val net = AppState.net.value
        val where = if (net == Net.Mobile) "mobile data" else "Wi-Fi"
        show(
            context,
            id = TRIED + (uid % SPAN),
            title = "${app.label} tried to use $where",
            text = "HProxy blocked it (${e.optString("host")}).",
            pkg = app.pkg,
            net = net,
        )
    }

    fun newApp(context: Context, pkg: String) {
        if (!Settings.prefs.value.tellBlocked) return
        val app = Firewall.installed(context).firstOrNull { it.pkg == pkg } ?: return
        show(
            context,
            id = NEW + (app.uid % SPAN),
            title = "New app ${app.label} is blocked",
            text = "It can use the internet once you allow it.",
            pkg = pkg,
            net = null,
        )
    }

    /** The rules changed: a notice about an app that is blocked nowhere any more is out of date,
     *  so it goes. Only the notices on the screen are looked at. */
    fun forgetAllowed(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        val shown = nm.activeNotifications.map { it.id }.filter { it in TRIED until TRIED + SPAN || it in NEW until NEW + SPAN }
        if (shown.isEmpty()) return
        val prefs = Settings.prefs.value
        val rules = Settings.rules.value
        val known = Settings.knownApps
        val apps = Firewall.installed(context)
        for (id in shown) {
            val uidPart = if (id >= NEW) id - NEW else id - TRIED
            val app = apps.firstOrNull { it.uid % SPAN == uidPart } ?: continue
            if (!Firewall.ruleOf(app.pkg, rules, prefs, known).blocksSomewhere) nm.cancel(id)
        }
    }

    private fun show(context: Context, id: Int, title: String, text: String, pkg: String, net: Net?) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            if (nm.getNotificationChannel(CHANNEL) == null) {
                val ch = NotificationChannel(CHANNEL, "Blocked apps", NotificationManager.IMPORTANCE_LOW)
                ch.description = "When an app you blocked tries to use the internet."
                nm.createNotificationChannel(ch)
            }
            Notification.Builder(context, CHANNEL)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(context).setPriority(Notification.PRIORITY_LOW)
        }
        val allow = Intent(context, AllowReceiver::class.java)
            .putExtra(AllowReceiver.PKG, pkg)
            .putExtra(AllowReceiver.NET, net?.name)
            .putExtra(AllowReceiver.ID, id)
        val allowing = PendingIntent.getBroadcast(context, id, allow, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).setAction(MainActivity.OPEN_APPS),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        @Suppress("DEPRECATION")
        val n = builder
            .setSmallIcon(R.drawable.ic_connected)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setColor(0xFF0158FF.toInt())
            .addAction(Notification.Action.Builder(null, "Allow", allowing).build())
            .build()
        try {
            nm.notify(id, n)
        } catch (e: SecurityException) {
            // No permission to show notifications: the firewall works the same.
        }
    }
}
