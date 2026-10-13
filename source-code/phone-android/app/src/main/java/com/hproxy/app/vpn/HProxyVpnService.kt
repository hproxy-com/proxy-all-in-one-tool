package com.hproxy.app.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import com.hproxy.app.MainActivity
import com.hproxy.app.R
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.Native
import com.hproxy.app.firewall.Firewall
import com.hproxy.app.firewall.Net
import com.hproxy.app.state.AppState
import com.hproxy.app.state.Settings
import java.util.concurrent.Executors
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

/**
 * Opens and changes the VPN, for AppState: `apply` makes it match the plan as things stand (a
 * proxy connected or not, the firewall's rules, the network the phone is on).
 */
object Vpn {
    @Volatile private var waiting: CompletableDeferred<Boolean>? = null

    /** Make the VPN match the plan, and wait until it does. False: Android refused it. */
    suspend fun apply(context: Context): Boolean {
        if (AppState.plan().mode == Firewall.Mode.None && HProxyVpnService.running == null) return true
        val done = CompletableDeferred<Boolean>()
        waiting = done
        if (!start(context, HProxyVpnService.ACTION_APPLY)) return false
        return withTimeoutOrNull(10_000) { done.await() } ?: false
    }

    /** The same, nobody waiting. */
    fun applyQuietly(context: Context) {
        if (AppState.plan().mode == Firewall.Mode.None && HProxyVpnService.running == null) return
        start(context, HProxyVpnService.ACTION_APPLY)
    }

    internal fun applied(ok: Boolean) {
        waiting?.complete(ok)
        waiting = null
    }

    private fun start(context: Context, action: String): Boolean {
        val intent = Intent(context, HProxyVpnService::class.java).setAction(action)
        return try {
            if (Build.VERSION.SDK_INT >= 26 && HProxyVpnService.running == null) context.startForegroundService(intent)
            else context.startService(intent)
            true
        } catch (e: Exception) {
            Log.e("HProxy", "the VPN service could not start", e)
            applied(false)
            false
        }
    }

    /** The tunnel ended by itself: the VPN is gone. */
    fun ended(context: Context, why: String) {
        Log.w("HProxy", "vpn: the tunnel ended: $why")
        HProxyVpnService.running?.let { it.close() }
        AppState.vpnRevoked()
    }
}

/**
 * The phone's VPN: every app's packets come here, and Rust reads them (the descriptor is handed to
 * the engine, proxy-engine/hproxy-mobile). This service opens the VPN with the apps the firewall
 * puts in it, keeps the notification while it runs, follows the network (Wi-Fi or mobile data, for
 * the firewall's rules), and closes it.
 */
class HProxyVpnService : VpnService() {
    companion object {
        private const val TAG = "HProxy"
        const val ACTION_APPLY = "com.hproxy.app.vpn.APPLY"
        const val ACTION_CONNECT = "com.hproxy.app.vpn.CONNECT"
        const val ACTION_DISCONNECT = "com.hproxy.app.vpn.DISCONNECT"
        private const val CHANNEL = "connection"
        private const val NOTIFICATION_ID = 1

        /** The running service, while the VPN is up. */
        @Volatile var running: HProxyVpnService? = null
            private set
    }

    /** VPN work happens on one thread, in order. */
    private val work = Executors.newSingleThreadExecutor { Thread(it, "hproxy-vpn") }
    private var mode = Firewall.Mode.None
    private var inside: Set<String>? = null
    private var outside: Set<String> = emptySet()
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    private var packages: BroadcastReceiver? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        AppState.start(applicationContext)
        when (intent?.action) {
            ACTION_APPLY -> {
                // Started to open a VPN: in front at once, as Android wants of a service started
                // that way. One that only closes it has nothing to show.
                if (AppState.plan().mode != Firewall.Mode.None) foreground(notification())
                work.execute { apply() }
            }
            ACTION_DISCONNECT -> AppState.disconnect()
            // The quick tile, the start of the phone, or Android itself (an always-on VPN set in
            // the phone's settings): the place connected last, or picked last. Without one, only
            // the firewall runs (when a rule blocks something).
            else -> {
                foreground(notification())
                AppState.scope.launch {
                    val lib = AppState.refreshLibrary()
                    val place = AppState.status.value.place ?: lib.picked
                    if (place != null) AppState.connect(place) else work.execute { apply() }
                }
            }
        }
        return START_NOT_STICKY
    }

    /** Make the VPN match the plan. On the VPN's own thread. */
    private fun apply() {
        val plan = AppState.plan()
        try {
            if (plan.mode == Firewall.Mode.None) {
                close()
                Vpn.applied(true)
                return
            }
            Engine.callNow("firewall", plan.table)
            val same = plan.mode == mode && plan.inside == inside && plan.outside == outside && running != null
            if (!same) {
                val fd = open(plan) ?: run {
                    Log.w(TAG, "vpn: Android did not let the VPN open")
                    close()
                    Vpn.applied(false)
                    return
                }
                val raw = fd.detachFd()
                if (plan.mode != mode || running == null) {
                    Engine.read(Native.tunnelStart(raw, plan.mode == Firewall.Mode.Proxy))
                } else {
                    Engine.read(Native.tunnelSwap(raw))
                }
                mode = plan.mode
                inside = plan.inside
                outside = plan.outside
            }
            running = this
            watchNetwork()
            watchPackages()
            notify(notification())
            Vpn.applied(true)
        } catch (e: EngineError) {
            Log.e(TAG, "vpn: ${e.message}")
            close()
            Vpn.applied(false)
        } catch (e: Exception) {
            Log.e(TAG, "vpn: the VPN could not be opened", e)
            close()
            Vpn.applied(false)
        }
    }

    /** The VPN itself, with the apps the plan puts in it; null when Android refuses it. */
    private fun open(plan: Firewall.Plan): ParcelFileDescriptor? {
        val args = Engine.callNow("vpnArgs") as JSONObject
        val builder = Builder().setSession(getString(R.string.app_name)).setMtu(args.optInt("mtu", 1500))
        fun each(a: JSONArray?, f: (String) -> Unit) {
            if (a != null) for (i in 0 until a.length()) f(a.getString(i))
        }
        each(args.optJSONArray("addresses")) { a ->
            val (ip, len) = a.split("/")
            builder.addAddress(ip, len.toInt())
        }
        each(args.optJSONArray("routes")) { r ->
            val (ip, len) = r.split("/")
            builder.addRoute(ip, len.toInt())
        }
        builder.addDnsServer(args.optString("dns"))
        val inside = plan.inside
        if (inside != null) {
            // Only these apps; this app is never one of them, so its relay reaches the proxy.
            for (pkg in inside) {
                try {
                    builder.addAllowedApplication(pkg)
                } catch (e: PackageManager.NameNotFoundException) {
                    Log.w(TAG, "vpn: $pkg is not installed any more")
                }
            }
        } else {
            for (pkg in plan.outside) {
                try {
                    builder.addDisallowedApplication(pkg)
                } catch (e: PackageManager.NameNotFoundException) {
                    Log.w(TAG, "vpn: $pkg is not installed any more")
                }
            }
        }
        builder.setConfigureIntent(openApp())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Apps judge the connection by the network under it (Wi-Fi is not metered).
            builder.setMetered(false)
        }
        return builder.establish()
    }

    /** The VPN ends: the tunnel closes its descriptor, the notification goes. */
    fun close() {
        try {
            Native.tunnelStop()
        } catch (e: Throwable) {
            Log.w(TAG, "vpn: stopping the tunnel", e)
        }
        mode = Firewall.Mode.None
        inside = null
        outside = emptySet()
        unwatch()
        running = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** Another VPN app took over, or the person turned HProxy off in the phone's settings. */
    override fun onRevoke() {
        work.execute {
            close()
            AppState.scope.launch { AppState.vpnRevoked() }
        }
    }

    override fun onDestroy() {
        if (running === this) running = null
        unwatch()
        work.shutdown()
        super.onDestroy()
    }

    // -------------------------------------------------------------------------------------------
    // Wi-Fi or mobile data, and new apps
    // -------------------------------------------------------------------------------------------

    private fun watchNetwork() {
        if (netCallback != null) return
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        fun follow(caps: NetworkCapabilities) {
            val net = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> Net.Mobile
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> Net.Wifi
                else -> Net.Other
            }
            AppState.scope.launch { AppState.setNet(net) }
        }
        val cb = object : ConnectivityManager.NetworkCallback() {
            // Android 7 names the network only here; from 8 on, onCapabilitiesChanged follows.
            override fun onAvailable(network: Network) {
                cm.getNetworkCapabilities(network)?.let(::follow)
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = follow(caps)
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            netCallback = cb
        } catch (e: Exception) {
            Log.w(TAG, "vpn: the network cannot be followed", e)
        }
    }

    /** A new app, while new apps are blocked until allowed: it is told about at once. */
    private fun watchPackages() {
        if (packages != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val pkg = intent.data?.schemeSpecificPart ?: return
                if (intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)) return
                work.execute {
                    Firewall.installed(applicationContext, fresh = true)
                    if (Settings.prefs.value.blockNewApps && pkg !in Settings.knownApps) {
                        com.hproxy.app.state.Blocked.newApp(applicationContext, pkg)
                    }
                    apply()
                }
            }
        }
        val filter = IntentFilter(Intent.ACTION_PACKAGE_ADDED).apply { addDataScheme("package") }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(r, filter, RECEIVER_NOT_EXPORTED) else registerReceiver(r, filter)
        packages = r
    }

    private fun unwatch() {
        netCallback?.let { cb ->
            try {
                getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb)
            } catch (e: Exception) {
            }
        }
        netCallback = null
        packages?.let {
            try {
                unregisterReceiver(it)
            } catch (e: Exception) {
            }
        }
        packages = null
    }

    // -------------------------------------------------------------------------------------------
    // The notification
    // -------------------------------------------------------------------------------------------

    /** In front: an active VPN is one of Android 14's "system exempted" reasons. */
    private fun foreground(n: Notification) {
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
            else startForeground(NOTIFICATION_ID, n)
        } catch (e: Exception) {
            // The VPN carries traffic either way: Android keeps a VPN's service running.
            Log.w(TAG, "vpn: the notification could not be shown", e)
        }
    }

    private fun notify(n: Notification) {
        try {
            getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, n)
        } catch (e: SecurityException) {
            Log.w(TAG, "vpn: no permission to update the notification", e)
        }
    }

    private fun notification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) == null) {
                val ch = NotificationChannel(CHANNEL, "Connection", NotificationManager.IMPORTANCE_LOW)
                ch.description = "Shows while HProxy connects this phone, or blocks apps."
                ch.setShowBadge(false)
                nm.createNotificationChannel(ch)
            }
            Notification.Builder(this, CHANNEL)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
        }
        val (title, text) = words()
        builder
            .setSmallIcon(R.drawable.ic_connected)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openApp())
            .setOngoing(true)
            .setShowWhen(false)
            .setColor(0xFF0158FF.toInt())
        if (AppState.wanted) builder.addAction(action("Disconnect", ACTION_DISCONNECT, 2))
        return builder.build()
    }

    private fun words(): Pair<String, String> {
        val shown = AppState.current()
        val health = AppState.health.value
        val blocked = if (mode != Firewall.Mode.None) AppState.plan().blockedHere else 0
        return when {
            AppState.fallenBack.value -> "Your proxy stopped answering" to "Apps use your own internet until it is back"
            AppState.wanted && health != null && !health.ok -> "Your proxy is not answering" to "Nothing goes around it: apps wait until it is back"
            AppState.wanted -> {
                val where = listOfNotNull(health?.exitIp, health?.city ?: health?.country).joinToString(" · ")
                "Connected · ${shown?.name ?: "HProxy"}" to where.ifEmpty { "Checking where you appear" }
            }
            blocked > 0 -> "HProxy is blocking ${if (blocked == 1) "1 app" else "$blocked apps"}" to "Which apps decides. Tap to change it."
            else -> "HProxy" to "Ready"
        }
    }

    private fun action(title: String, what: String, code: Int): Notification.Action {
        val intent = Intent(this, HProxyVpnService::class.java).setAction(what)
        val pending = PendingIntent.getService(this, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        @Suppress("DEPRECATION")
        return Notification.Action.Builder(null, title, pending).build()
    }

    private fun openApp(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** The notification says what changed (a probe, a switch). */
    fun refresh() {
        if (running === this) notify(notification())
    }
}
