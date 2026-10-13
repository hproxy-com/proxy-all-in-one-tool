package com.hproxy.app.engine

import android.content.Context
import com.hproxy.app.BuildConfig
import org.json.JSONArray
import org.json.JSONObject

/**
 * Store pictures and the website's films, made from the app itself: in the "pictures" build only
 * (BuildConfig.PICTURES; the Play build has none of this, R8 drops it). Everything the engine
 * hands the screen passes through [out]: every public address becomes one set aside for examples
 * (IPv4 RFC 5737, IPv6 RFC 3849), the same one every time, and every network's name a plain
 * description. Everything the screen hands the engine passes through [into], which turns those
 * example addresses back into the real ones, so connecting and checking still work for real.
 *
 * [seed] names the pairs up front ("203.0.113.20=<real>"), so a list typed with example
 * addresses checks the real proxies behind them.
 */
object Pictures {
    /** A constant, so every `if (Pictures.on)` of the Play build is `if (false)` and this whole
     *  object is left out of it. */
    const val on: Boolean = BuildConfig.PICTURES

    private val toExample = HashMap<String, String>()
    private val toReal = HashMap<String, String>()

    // An address ends a sentence too ("... at 203.0.113.7."): only a digit, or a dot and a digit,
    // around it makes it part of something longer. A range ("100.128.0.0/9") is nobody's address
    // and the VPN's routes are made of them: Android refuses a route rewritten into an example.
    private val ipv4 = Regex("""(?<!\d)(?<!\d\.)(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d)(?!\.\d)(?!/\d)""")
    // Never right after a dot: "203.0.113.5:8080:beef:cafe" is an address, a port and a login.
    private val ipv6 = Regex("""(?<![\w:.])(?:(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,6}:(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,5})?)(?![\w:])(?!/\d)""")

    /** Plain words for a network, as the earlier store pictures used (desktop-app/scripts/store-play-images.mjs). */
    private val HOSTING = listOf("Cloud Hosting", "Data Center", "Server Hosting", "Edge Hosting")
    private val HOME = listOf("Home Broadband", "Home Fiber", "Metro Telecom", "City Broadband")

    @Synchronized
    fun load(context: Context) {
        if (!on) return
        context.getSharedPreferences("pictures", Context.MODE_PRIVATE).getString("pairs", null)?.let { pair(it) }
    }

    /** "example=real,example=real": kept for the next start too. */
    @Synchronized
    fun seed(context: Context, pairs: String) {
        if (!on) return
        pair(pairs)
        val all = toExample.entries.joinToString(",") { "${it.value}=${it.key}" }
        context.getSharedPreferences("pictures", Context.MODE_PRIVATE).edit().putString("pairs", all).apply()
    }

    private fun pair(pairs: String) {
        for (p in pairs.split(',', '\n')) {
            val (example, real) = p.split('=').map { it.trim() }.takeIf { it.size == 2 && it.all(String::isNotEmpty) } ?: continue
            toExample[real] = example
            toReal[example] = real
        }
    }

    /** The engine's words, as the screen may show them. */
    @Synchronized
    fun out(raw: String): String {
        if (!on) return raw
        val text = ipv6.replace(ipv4.replace(raw) { example(it.value, v6 = false) }) { example(it.value, v6 = true) }
        val json: Any = try {
            if (text.trimStart().startsWith("[")) JSONArray(text) else JSONObject(text)
        } catch (e: Exception) {
            return text
        }
        plain(json)
        return json.toString()
    }

    /** The screen's words, as the engine needs them: example addresses back to the real ones. */
    @Synchronized
    fun into(raw: String): String {
        if (!on || toReal.isEmpty()) return raw
        return ipv6.replace(ipv4.replace(raw) { toReal[it.value] ?: it.value }) { toReal[it.value] ?: it.value }
    }

    private fun example(ip: String, v6: Boolean): String {
        if (kept(ip, v6)) return ip
        toExample[ip]?.let { return it }
        // The same address gets the same example every time it shows: from its hash, the next
        // free one after a clash, so every example names one address only.
        var i = (ip.hashCode() and 0x7fffffff) % (if (v6) 4096 else 3 * 250)
        while (true) {
            val e = if (v6) "2001:db8:${(0x100 + i).toString(16)}::${(i % 250 + 2).toString(16)}"
            else "${listOf("203.0.113", "198.51.100", "192.0.2")[i / 250]}.${i % 250 + 3}"
            if (e !in toReal) {
                toExample[ip] = e
                toReal[e] = ip
                return e
            }
            i = (i + 1) % (if (v6) 4096 else 3 * 250)
        }
    }

    /** Addresses that are not anyone's: this phone's own network, the tunnel, and the examples. */
    private fun kept(ip: String, v6: Boolean): Boolean {
        if (v6) {
            val l = ip.lowercase()
            return l.startsWith("2001:db8") || l.startsWith("fe80") || l.startsWith("fd") || l.startsWith("fc") ||
                l.startsWith("64:ff9b") || l == "::1"
        }
        val (a, b, c) = ip.split('.').map { it.toInt() }
        // x.0.0.0 is a network, never a machine: a browser's version ("Chrome/140.0.0.0").
        if (ip.endsWith(".0.0.0")) return true
        return a == 0 || a == 10 || a == 127 || a >= 224 ||
            (a == 100 && b in 64..127) || (a == 169 && b == 254) || (a == 172 && b in 16..31) ||
            (a == 192 && b == 168) || (a == 198 && b in 18..19) ||
            (a == 192 && b == 0 && c == 2) || (a == 198 && b == 51 && c == 100) || (a == 203 && b == 0 && c == 113)
    }

    /** A network's name becomes plain words: hosting or a home line, as the engine knows it. */
    private fun plain(v: Any?) {
        when (v) {
            is JSONObject -> {
                // A probe's network ("asn_org") and a free proxy's ("network", the free list).
                for (key in listOf("asn_org", "network")) {
                    val org = v.optString(key).takeIf { v.has(key) && !v.isNull(key) && it.isNotEmpty() } ?: continue
                    val words = if (v.optBoolean("datacenter", false)) HOSTING else HOME
                    v.put(key, words[(org.hashCode() and 0x7fffffff) % words.size])
                }
                for (k in v.keys()) plain(v.opt(k))
            }
            is JSONArray -> for (i in 0 until v.length()) plain(v.opt(i))
        }
    }
}
