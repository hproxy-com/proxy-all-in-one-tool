package com.hproxy.app.state

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

/** What the person set, kept in the app's private preferences (never backed up). */
data class Prefs(
    /** "If it drops": block the internet until the proxy is back (on), or use the phone's own. */
    val blockWhenDown: Boolean = true,
    val connectOnStartup: Boolean = false,
    /** Every app through the proxy, unless its rule says otherwise. */
    val allThroughProxy: Boolean = true,
    /** Say when a blocked app tries to connect. */
    val tellBlocked: Boolean = true,
    /** A new app may not use the internet until it is allowed. */
    val blockNewApps: Boolean = false,
    val showSystemApps: Boolean = false,
)

/** Where a place came out: its exit's city on the map. */
data class Exit(val lat: Double, val lng: Double, val city: String?, val cc: String?)

/** One app's rule. `proxy` null: as `allThroughProxy` says. */
data class AppRule(val proxy: Boolean? = null, val wifi: Boolean = true, val mobile: Boolean = true) {
    val blocksSomewhere: Boolean get() = !wifi || !mobile
    val isDefault: Boolean get() = proxy == null && wifi && mobile

    fun json(): JSONObject = JSONObject().apply {
        proxy?.let { put("proxy", it) }
        put("wifi", wifi)
        put("mobile", mobile)
    }

    companion object {
        fun of(o: JSONObject): AppRule = AppRule(
            proxy = if (o.has("proxy")) o.optBoolean("proxy") else null,
            wifi = o.optBoolean("wifi", true),
            mobile = o.optBoolean("mobile", true),
        )
    }
}

object Settings {
    private lateinit var sp: SharedPreferences
    private val prefsFlow = MutableStateFlow(Prefs())
    private val rulesFlow = MutableStateFlow<Map<String, AppRule>>(emptyMap())

    val prefs: StateFlow<Prefs> = prefsFlow.asStateFlow()
    /** Per app, by package name. */
    val rules: StateFlow<Map<String, AppRule>> = rulesFlow.asStateFlow()

    fun load(context: Context) {
        sp = context.getSharedPreferences("hproxy", Context.MODE_PRIVATE)
        prefsFlow.value = Prefs(
            blockWhenDown = sp.getBoolean("blockWhenDown", true),
            connectOnStartup = sp.getBoolean("connectOnStartup", false),
            allThroughProxy = sp.getBoolean("allThroughProxy", true),
            tellBlocked = sp.getBoolean("tellBlocked", true),
            blockNewApps = sp.getBoolean("blockNewApps", false),
            showSystemApps = sp.getBoolean("showSystemApps", false),
        )
        val raw = sp.getString("rules", null)
        rulesFlow.value = try {
            val o = JSONObject(raw ?: "{}")
            o.keys().asSequence().associateWith { AppRule.of(o.getJSONObject(it)) }
        } catch (e: Exception) {
            emptyMap()
        }
        loadConnector()
    }

    fun update(f: (Prefs) -> Prefs) {
        val p = f(prefsFlow.value)
        prefsFlow.value = p
        sp.edit()
            .putBoolean("blockWhenDown", p.blockWhenDown)
            .putBoolean("connectOnStartup", p.connectOnStartup)
            .putBoolean("allThroughProxy", p.allThroughProxy)
            .putBoolean("tellBlocked", p.tellBlocked)
            .putBoolean("blockNewApps", p.blockNewApps)
            .putBoolean("showSystemApps", p.showSystemApps)
            .apply()
    }

    fun setRule(pkg: String, rule: AppRule) {
        val next = rulesFlow.value.toMutableMap()
        if (rule.isDefault) next.remove(pkg) else next[pkg] = rule
        rulesFlow.value = next
        val o = JSONObject()
        for ((k, v) in next) o.put(k, v.json())
        sp.edit().putString("rules", o.toString()).apply()
    }

    /** The apps there were when "block new apps" was switched on: every other one is new. */
    var knownApps: Set<String>
        get() = sp.getStringSet("knownApps", emptySet()) ?: emptySet()
        set(v) = sp.edit().putStringSet("knownApps", v).apply()

    /**
     * The start of the phone ([bootCount]) in which a connection is on, -1 when none is: an update
     * of the app brings back only a connection that was on in this very start. Disconnect, another
     * VPN taking over and the phone's settings turning HProxy off all end it; a restart of the
     * phone ends it by itself. It replaces "wasConnected" (0.3.0 to 0.3.6), which only Disconnect
     * cleared, so an update could turn on a VPN its person had left long before, even push another
     * VPN app aside (found 2026-10-13); that key is never read again.
     */
    var connectedInBoot: Int
        get() = sp.getInt("connectedInBoot", -1)
        set(v) = sp.edit().putInt("connectedInBoot", v).apply()

    /** Which start of the phone this is (Android counts them since 7.0); -1 on a phone that does
     *  not say, where nothing then connects again by itself after an update. */
    fun bootCount(context: Context): Int =
        android.provider.Settings.Global.getInt(context.contentResolver, android.provider.Settings.Global.BOOT_COUNT, -1)

    /** The old app's saved proxies were looked for once (migrate/OldAppStorage.kt). */
    var lookedForOldProxies: Boolean
        get() = sp.getBoolean("lookedForOldProxies", false)
        set(v) = sp.edit().putBoolean("lookedForOldProxies", v).apply()

    /** Where each place came out last (its exit's city), so the map can dive there at once the
     *  next time, before the probe says it again. */
    fun lastExit(placeKey: String): Exit? = try {
        sp.getString("exit:$placeKey", null)?.let { JSONObject(it) }?.let {
            Exit(it.getDouble("lat"), it.getDouble("lng"), it.optString("city").ifEmpty { null }, it.optString("cc").ifEmpty { null })
        }
    } catch (e: Exception) {
        null
    }

    fun rememberExit(placeKey: String, exit: Exit) {
        val o = JSONObject().put("lat", exit.lat).put("lng", exit.lng).put("city", exit.city ?: "").put("cc", exit.cc ?: "")
        sp.edit().putString("exit:$placeKey", o.toString()).apply()
    }

    /** When the clipboard was last read for proxies, so the same one is not read twice. */
    var clipboardSeenAt: Long
        get() = sp.getLong("clipboardSeenAt", 0)
        set(v) = sp.edit().putLong("clipboardSeenAt", v).apply()

    // -----------------------------------------------------------------------------------------
    // The proxy connector (2026-10-11)
    // -----------------------------------------------------------------------------------------

    private val freeNamesFlow = MutableStateFlow<Map<String, String>>(emptyMap())
    private val checkersFlow = MutableStateFlow(CheckerId.entries.associateWith { CheckerSet(on = it == CheckerId.Ffraud) })
    private val judgeFlow = MutableStateFlow(JudgeSet())

    /** Names given to free proxies, by "host:port". A saved
     *  proxy's name lives with it in the library. */
    val freeNames: StateFlow<Map<String, String>> = freeNamesFlow.asStateFlow()
    /** The fraud score checkers: on or off, and their keys (the computer app's five). */
    val checkers: StateFlow<Map<CheckerId, CheckerSet>> = checkersFlow.asStateFlow()
    /** Who judges the checker's runs. */
    val judge: StateFlow<JudgeSet> = judgeFlow.asStateFlow()

    /** Read with the rest in `load`: the connector's own settings. */
    fun loadConnector() {
        freeNamesFlow.value = try {
            val o = JSONObject(sp.getString("freeNames", null) ?: "{}")
            o.keys().asSequence().associateWith { o.optString(it) }.filterValues { it.isNotBlank() }
        } catch (e: Exception) {
            emptyMap()
        }
        checkersFlow.value = try {
            val o = JSONObject(sp.getString("checkers", null) ?: "{}")
            CheckerId.entries.associateWith { id ->
                o.optJSONObject(id.wire)?.let { CheckerSet(it.optBoolean("on"), it.optString("key")) }
                    ?: CheckerSet(on = id == CheckerId.Ffraud)
            }
        } catch (e: Exception) {
            checkersFlow.value
        }
        judgeFlow.value = JudgeSet(
            kind = JudgeKind.entries.find { it.wire == sp.getString("judgeKind", null) } ?: JudgeKind.Hproxy,
            url = sp.getString("judgeUrl", "") ?: "",
        )
    }

    fun nameFree(addr: String, name: String) {
        val next = freeNamesFlow.value.toMutableMap()
        if (name.isBlank()) next.remove(addr) else next[addr] = name
        freeNamesFlow.value = next
        sp.edit().putString("freeNames", JSONObject(next as Map<*, *>).toString()).apply()
    }

    fun setChecker(id: CheckerId, set: CheckerSet) {
        val next = checkersFlow.value.toMutableMap().also { it[id] = set }
        checkersFlow.value = next
        val o = JSONObject()
        for ((k, v) in next) o.put(k.wire, JSONObject().put("on", v.on).put("key", v.key))
        sp.edit().putString("checkers", o.toString()).apply()
    }

    fun setJudge(j: JudgeSet) {
        judgeFlow.value = j
        sp.edit().putString("judgeKind", j.kind.wire).putString("judgeUrl", j.url).apply()
    }

    /** The Proxies tab's list last shown ("Mine" or "Free"). */
    var shelf: String
        get() = sp.getString("shelf", null) ?: "Free"
        set(v) = sp.edit().putString("shelf", v).apply()

    /** The support chat's visitor token, so the person's own thread comes back. */
    var chatToken: String?
        get() = sp.getString("chatToken", null)
        set(v) = sp.edit().putString("chatToken", v).apply()
}

/**
 * The fraud score checkers, the computer app's five, in its order and words
 * (desktop-app/src/lib/fraud.ts FRAUD_SERVICES; the engine's hproxy-api fraud.rs).
 */
enum class CheckerId(val wire: String, val label: String, val keyLabel: String?, val keyHint: String?, val keyOptional: Boolean, val about: String) {
    Ffraud("ffraud", "FFraud", null, null, false, "Free, no key needed. A score from 0 to 100, a risk word and the reason."),
    Ipqs("ipqs", "IPQualityScore", "API key", "Your IPQualityScore API key", false, "Its fraud score, 0 to 100."),
    Scamalytics(
        "scamalytics", "Scamalytics", "API address, or username:key", "https://api11.scamalytics.com/v3/you/?key=…", false,
        "Its score, 0 to 100, and its risk word.",
    ),
    Proxycheck("proxycheck", "proxycheck.io", "API key", "Works without one, 100 lookups a day", true, "Its risk score, 0 to 100."),
    Abuseipdb("abuseipdb", "AbuseIPDB", "API key", "Your AbuseIPDB API key", false, "Its abuse confidence, 0 to 100, and how often the address was reported.");

    /** What the engine is sent: `{"service":"ipqs","key":"..."}` (Scamalytics names it "address"). */
    fun json(key: String): JSONObject = JSONObject().put("service", wire).apply {
        val k = key.trim()
        when (this@CheckerId) {
            Ffraud -> {}
            Scamalytics -> put("address", k)
            Proxycheck -> if (k.isNotEmpty()) put("key", k)
            else -> put("key", k)
        }
    }
}

data class CheckerSet(val on: Boolean = false, val key: String = "") {
    /** On, and able to answer: a key when its service needs one. */
    fun answers(id: CheckerId): Boolean = on && (id.keyLabel == null || id.keyOptional || key.isNotBlank())
}

enum class JudgeKind(val wire: String, val label: String, val about: String) {
    Hproxy("hproxy", "HProxy", "Sees the address you appear as and every header, so it can tell how well a proxy hides you"),
    Cloudflare("cloudflare", "Cloudflare", "Sees the address you appear as"),
    Own("own", "Your own judge", "Any address of yours that answers, typed in"),
}

data class JudgeSet(val kind: JudgeKind = JudgeKind.Hproxy, val url: String = "") {
    /** As the engine's checker takes it (`StartInput.judge`). */
    fun json(): JSONObject = JSONObject().put("kind", kind.wire).apply { if (kind == JudgeKind.Own) put("url", url.trim()) }
    val name: String get() = if (kind == JudgeKind.Own) url.trim().ifEmpty { kind.label } else kind.label
}
