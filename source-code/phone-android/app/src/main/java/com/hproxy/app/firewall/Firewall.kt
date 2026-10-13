package com.hproxy.app.firewall

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import com.hproxy.app.state.AppRule
import com.hproxy.app.state.Prefs
import org.json.JSONObject

/** An app a person opens from the launcher. */
data class InstalledApp(val pkg: String, val label: String, val uid: Int, val system: Boolean)

/** The network the phone is on: the firewall's rules are per kind of network. */
enum class Net { Wifi, Mobile, Other }

/**
 * Which apps (the firewall, after NetGuard's idea, built here): per app, through the proxy or not,
 * allowed on Wi-Fi, allowed on mobile data.
 *
 * Android gives a VPN its apps as a list, set when the VPN opens: an app outside it is not touched
 * at all (it uses the phone's own internet, calls and games included). So only the apps something
 * must happen to are put in it, and the engine's gate decides each of their connections by the
 * table made here (proxy-engine/hproxy-mobile, firewall.rs):
 *
 *   connected     every app through the proxy, except the ones that go direct everywhere (left
 *                 out), the blocked ones refused on the network they are blocked on
 *   not connected only the apps blocked somewhere are in it: refused where they are blocked,
 *                 straight out where they are allowed
 *
 * The list is made again when a rule changes or a proxy connects or disconnects; a change of
 * network only changes the table, so moving between Wi-Fi and mobile data cuts nothing.
 */
object Firewall {
    enum class Mode { None, Proxy, Alone }

    /** What the VPN opens with and what the gate is told. */
    data class Plan(
        val mode: Mode,
        /** Only these apps in the VPN (null: every app but `outside`). */
        val inside: Set<String>?,
        /** These apps left out of the VPN (with `inside` null). */
        val outside: Set<String>,
        val table: JSONObject,
        /** Apps blocked on the network the phone is on now. */
        val blockedHere: Int,
    )

    @Volatile private var cache: List<InstalledApp>? = null

    /** The apps on the phone (launcher apps, this one left out), by name. */
    fun installed(context: Context, fresh: Boolean = false): List<InstalledApp> {
        cache?.takeIf { !fresh }?.let { return it }
        val pm = context.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        @Suppress("DEPRECATION")
        val found = pm.queryIntentActivities(launcher, 0)
            .map { it.activityInfo.packageName }
            .filter { it != context.packageName }
            .distinct()
            .mapNotNull { pkg ->
                try {
                    @Suppress("DEPRECATION")
                    val info = pm.getApplicationInfo(pkg, 0)
                    InstalledApp(
                        pkg = pkg,
                        label = pm.getApplicationLabel(info).toString(),
                        uid = info.uid,
                        system = info.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0,
                    )
                } catch (e: PackageManager.NameNotFoundException) {
                    null
                }
            }
            .sortedBy { it.label.lowercase() }
        cache = found
        return found
    }

    /** An app's rule as it applies: its own, or blocked everywhere when it is new and new apps
     *  are blocked until allowed. */
    fun ruleOf(pkg: String, rules: Map<String, AppRule>, prefs: Prefs, known: Set<String>): AppRule =
        rules[pkg] ?: if (prefs.blockNewApps && known.isNotEmpty() && pkg !in known) AppRule(wifi = false, mobile = false) else AppRule()

    fun throughProxy(rule: AppRule, prefs: Prefs): Boolean = rule.proxy ?: prefs.allThroughProxy

    fun blockedOn(rule: AppRule, net: Net): Boolean = when (net) {
        Net.Mobile -> !rule.mobile
        Net.Wifi, Net.Other -> !rule.wifi
    }

    fun plan(
        context: Context,
        connected: Boolean,
        net: Net,
        prefs: Prefs,
        rules: Map<String, AppRule>,
        known: Set<String>,
    ): Plan {
        val apps = installed(context)
        val rule = apps.associate { it.pkg to ruleOf(it.pkg, rules, prefs, known) }
        val blockedSomewhere = apps.filter { rule.getValue(it.pkg).blocksSomewhere }.map { it.pkg }.toSet()
        val viaProxy = apps.filter { throughProxy(rule.getValue(it.pkg), prefs) }.map { it.pkg }.toSet()

        val mode = when {
            connected && (prefs.allThroughProxy || viaProxy.isNotEmpty()) -> Mode.Proxy
            blockedSomewhere.isNotEmpty() -> Mode.Alone
            else -> Mode.None
        }
        val (inside, outside) = when (mode) {
            Mode.Proxy ->
                if (prefs.allThroughProxy) {
                    val direct = apps.filter { !throughProxy(rule.getValue(it.pkg), prefs) && it.pkg !in blockedSomewhere }.map { it.pkg }
                    null to (direct + context.packageName).toSet()
                } else {
                    (viaProxy + blockedSomewhere) to emptySet()
                }
            Mode.Alone -> blockedSomewhere to emptySet()
            Mode.None -> null to emptySet()
        }

        // The gate's table: each app's way on this network, by its user id. Apps that share one
        // id (rare) take the strictest of their ways.
        val byUid = HashMap<Int, String>()
        var blockedHere = 0
        for (app in apps) {
            val r = rule.getValue(app.pkg)
            val way = when {
                blockedOn(r, net) -> "block"
                mode == Mode.Proxy && throughProxy(r, prefs) -> "proxy"
                else -> "direct"
            }
            if (way == "block") blockedHere++
            val before = byUid[app.uid]
            byUid[app.uid] = when {
                before == "block" || way == "block" -> "block"
                before == "proxy" || way == "proxy" -> "proxy"
                else -> "direct"
            }
        }
        val default = if (mode == Mode.Proxy && prefs.allThroughProxy) "proxy" else "direct"
        val decisions = JSONObject()
        for ((uid, way) in byUid) if (way != default) decisions.put(uid.toString(), way)
        val table = JSONObject()
            .put("decisions", decisions)
            .put("default", default)
            .put("notify", prefs.tellBlocked)
        return Plan(mode, inside, outside, table, blockedHere)
    }
}
