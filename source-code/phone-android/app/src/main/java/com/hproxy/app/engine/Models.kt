package com.hproxy.app.engine

import java.util.Locale
import org.json.JSONObject

/** What kind of address the traffic leaves from: HProxy logins say it (`-type-mobile`), for
 *  other proxies the last check's network data does. */
enum class Kind(val label: String) {
    Residential("Residential"),
    Mobile("Mobile"),
    Isp("ISP"),
    Datacenter("Datacenter"),
    Free("Free"),
    Unknown("Proxy");

    companion object {
        fun of(word: String?): Kind? = when (word?.lowercase()) {
            "residential" -> Residential
            "mobile" -> Mobile
            "isp" -> Isp
            "datacenter" -> Datacenter
            else -> null
        }
    }
}

/** What a login targets (hproxy-places, targeting.rs). */
data class Targeting(
    val country: String? = null,
    val region: String? = null,
    val city: String? = null,
    val session: String? = null,
    val minutes: Int? = null,
    val kind: Kind? = null,
) {
    companion object {
        fun of(o: JSONObject?): Targeting? = o?.let {
            Targeting(
                country = it.str("country"),
                region = it.str("region"),
                city = it.str("city"),
                session = it.str("session"),
                minutes = it.int("minutes"),
                kind = Kind.of(it.str("kind")),
            )
        }
    }
}

/** What a proxy's last check or probe found. */
data class Verdict(
    val ok: Boolean,
    val latencyMs: Int?,
    val cc: String?,
    val place: String?,
    val exitIp: String?,
    val says: String?,
    val tone: String?,
    val datacenter: Boolean?,
    val at: Long,
) {
    companion object {
        fun of(o: JSONObject?): Verdict? = o?.let {
            Verdict(
                ok = it.optBoolean("ok"),
                latencyMs = it.int("latencyMs"),
                cc = it.str("cc"),
                place = it.str("place"),
                exitIp = it.str("exitIp"),
                says = it.str("says"),
                tone = it.str("tone"),
                datacenter = it.bool("datacenter"),
                at = it.optLong("at"),
            )
        }
    }
}

/** A place to connect through, as the engine names it (hproxy_places::Place). */
sealed class PlaceRef {
    data class Proxy(val id: String) : PlaceRef()
    data class Group(val id: String) : PlaceRef()
    /** A free proxy: one exit picked from the free list (`exit` "host:port", spoken to over
     *  SOCKS5 or HTTP), held exactly, never swapped for another (the engine's
     *  Source::exact_free, 2026-10-11). Without an exit, the fastest of a country ("" anywhere),
     *  which the pool may replace: only "any" ever means any. */
    data class Free(val country: String, val exit: String? = null, val socks5: Boolean = false) : PlaceRef()

    fun json(): JSONObject = when (this) {
        is Proxy -> jsonOf("kind" to "proxy", "id" to id)
        is Group -> jsonOf("kind" to "group", "id" to id)
        is Free -> jsonOf("kind" to "free", "country" to country, "socks5" to socks5, "exit" to exit)
    }

    val key: String
        get() = when (this) {
            is Proxy -> "p:$id"
            is Group -> "g:$id"
            is Free -> if (exit != null) "x:$exit" else "f:$country"
        }

    companion object {
        fun of(o: JSONObject?): PlaceRef? = when (o?.str("kind")) {
            "proxy" -> o.str("id")?.let { Proxy(it) }
            "group" -> o.str("id")?.let { Group(it) }
            "free" -> Free(o.optString("country", ""), o.str("exit"), o.optBoolean("socks5"))
            else -> null
        }
    }
}

/**
 * One free proxy as a row of the free list shows it (the engine's `freeList`): the proxy itself,
 * where it is, its network, and how fast and how often it answered the pool's checks. Untested from
 * this phone: connecting to it tests it.
 */
data class FreeExit(
    val host: String,
    val port: Int,
    /** "HTTP" or "SOCKS5". */
    val proto: String,
    val cc: String?,
    val city: String?,
    val region: String?,
    val network: String?,
    val ms: Int?,
    val uptime: Double?,
    val datacenter: Boolean?,
    val lat: Double?,
    val lng: Double?,
    /** When the pool last saw it answer (milliseconds since 1970), for "Checked most recently". */
    val verifiedAt: Long?,
) {
    val addr: String get() = "$host:$port"
    val ref: PlaceRef.Free get() = PlaceRef.Free(cc?.uppercase() ?: "", addr, socks5 = proto == "SOCKS5")
    val kind: Kind get() = when (datacenter) {
        true -> Kind.Datacenter
        false -> Kind.Residential
        null -> Kind.Unknown
    }
    /** "Nuremberg, Germany", or the country alone when the city is not known. */
    val where: String get() = listOfNotNull(city?.takeIf { it.isNotBlank() }, countryName(cc) ?: cc?.uppercase()).joinToString(", ").ifEmpty { "Somewhere" }

    companion object {
        fun of(o: JSONObject) = FreeExit(
            host = o.optString("host"),
            port = o.optInt("port"),
            proto = o.optString("proto", "HTTP"),
            cc = o.str("cc")?.lowercase()?.takeIf { it.length == 2 },
            city = o.str("city")?.takeIf { it.isNotBlank() },
            region = o.str("region")?.takeIf { it.isNotBlank() },
            network = o.str("network")?.takeIf { it.isNotBlank() },
            ms = o.int("ms"),
            uptime = o.dbl("uptime"),
            datacenter = o.bool("datacenter"),
            lat = o.dbl("lat"),
            lng = o.dbl("lng"),
            verifiedAt = o.str("verifiedAt")?.let(::isoMillis),
        )
    }
}

/** "2026-10-11T18:42:55.399470Z" to milliseconds, to the second. Not java.time: Android 7 has none. */
fun isoMillis(s: String): Long? = try {
    val f = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
    f.timeZone = java.util.TimeZone.getTimeZone("UTC")
    f.parse(s.take(19))?.time
} catch (e: Exception) {
    null
}

data class ProxyItem(
    val id: String,
    val name: String?,
    val address: String,
    val user: String?,
    val scheme: String?,
    val about: Targeting?,
    val lastUsedAt: Long,
    val uses: Long,
    val last: Verdict?,
)

data class GroupItem(
    val id: String,
    val name: String,
    val size: Int,
    val rule: String,
    val sessions: Int,
    val shared: Targeting,
    val lastUsedAt: Long,
    val uses: Long,
)

data class Library(
    val proxies: List<ProxyItem> = emptyList(),
    val groups: List<GroupItem> = emptyList(),
    val picked: PlaceRef? = null,
    val movedFromWindow: Boolean = false,
    val notice: String? = null,
) {
    val empty: Boolean get() = proxies.isEmpty() && groups.isEmpty()

    companion object {
        fun of(o: JSONObject): Library = Library(
            proxies = (o.optJSONArray("proxies") ?: org.json.JSONArray()).map { p ->
                ProxyItem(
                    id = p.optString("id"),
                    name = p.str("name"),
                    address = p.optString("address"),
                    user = p.str("user"),
                    scheme = p.str("scheme"),
                    about = Targeting.of(p.objOrNull("about")),
                    lastUsedAt = p.optLong("lastUsedAt"),
                    uses = p.optLong("uses"),
                    last = Verdict.of(p.objOrNull("last")),
                )
            },
            groups = (o.optJSONArray("groups") ?: org.json.JSONArray()).map { g ->
                val summary = g.optJSONObject("summary") ?: JSONObject()
                GroupItem(
                    id = g.optString("id"),
                    name = g.optString("name"),
                    size = g.optInt("size"),
                    rule = g.optString("rule"),
                    sessions = summary.optInt("sessions"),
                    shared = Targeting.of(summary.optJSONObject("shared")) ?: Targeting(),
                    lastUsedAt = g.optLong("lastUsedAt"),
                    uses = g.optLong("uses"),
                )
            },
            picked = PlaceRef.of(o.objOrNull("picked")),
            movedFromWindow = o.optBoolean("movedFromWindow"),
            notice = o.str("notice"),
        )
    }
}

/** What the last probe through the relay found (hproxy-connection, health.rs). */
data class Health(
    val ok: Boolean,
    val latencyMs: Int?,
    val exitIp: String?,
    val countryCode: String?,
    val country: String?,
    val city: String?,
    val asnOrg: String?,
    val datacenter: Boolean?,
    val timezone: String?,
    val latitude: Double?,
    val longitude: Double?,
    val error: String?,
    val failuresInARow: Int,
    val checkedAtMs: Long,
) {
    companion object {
        fun of(o: JSONObject?): Health? = o?.let {
            Health(
                ok = it.optBoolean("ok"),
                latencyMs = it.int("latency_ms"),
                exitIp = it.str("exit_ip"),
                countryCode = it.str("country_code")?.lowercase(),
                country = it.str("country"),
                city = it.str("city"),
                asnOrg = it.str("asn_org"),
                datacenter = it.bool("datacenter"),
                timezone = it.str("timezone"),
                latitude = it.dbl("latitude"),
                longitude = it.dbl("longitude"),
                error = it.str("error"),
                failuresInARow = it.optInt("failures_in_a_row"),
                checkedAtMs = it.optLong("checked_at_ms"),
            )
        }
    }
}

data class Stats(val connections: Long, val failures: Long, val bytesUp: Long, val bytesDown: Long) {
    companion object {
        val ZERO = Stats(0, 0, 0, 0)
        fun of(o: JSONObject?): Stats = o?.let {
            Stats(it.optLong("connections"), it.optLong("failures"), it.optLong("bytes_up"), it.optLong("bytes_down"))
        } ?: ZERO
    }
}

/** The connection as the engine runs it (hproxy-connection, connection.rs). */
data class Status(
    val running: Boolean,
    val place: PlaceRef?,
    val startedAtMs: Long?,
    val stats: Stats,
    val health: Health?,
    val notice: String?,
    val route: Long?,
    /** For a group, the member in use (its place in the group, from 0). */
    val member: Int?,
    val freeExit: String?,
) {
    companion object {
        val OFF = Status(false, null, null, Stats.ZERO, null, null, null, null, null)
        fun of(o: JSONObject): Status {
            val source = o.objOrNull("source")
            return Status(
                running = o.optBoolean("running"),
                place = PlaceRef.of(o.objOrNull("place")),
                startedAtMs = o.long("started_at_ms"),
                stats = Stats.of(o.objOrNull("stats")),
                health = Health.of(o.objOrNull("health")),
                notice = o.str("notice"),
                route = o.long("route"),
                member = source?.int("member"),
                freeExit = source?.str("detail"),
            )
        }
    }
}

/** A country's name in plain English, from its two letters ("de" → "Germany"). */
fun countryName(cc: String?): String? {
    if (cc.isNullOrBlank() || cc.length != 2) return null
    val name = runCatching { Locale.Builder().setRegion(cc.uppercase()).build().getDisplayCountry(Locale.ENGLISH) }.getOrNull() ?: return null
    return name.takeIf { it.isNotBlank() && !it.equals(cc, ignoreCase = true) }
}

/** A provider's spelling of a place, for reading: "new_york" reads "New York". */
fun spelled(raw: String): String =
    if (raw.length == 2) raw.uppercase()
    else raw.split('-', '_', ' ').filter { it.isNotEmpty() }
        .joinToString(" ") { w -> w.lowercase().replaceFirstChar { it.titlecase(Locale.ENGLISH) } }

/**
 * A place as every screen shows it: its name, its kind, its flag, and its line. The kind is said in
 * plain words in the line ("Residential · 100 sessions").
 */
data class Shown(
    val ref: PlaceRef,
    val name: String,
    val kind: Kind,
    val cc: String?,
    /** "Residential · 100 sessions", under the name on the main screen. */
    val line: String,
    /** For rows: what it targets, or what its last check found. */
    val sub: String,
    /** Round trip of the last check, when there was one. */
    val ms: Int?,
    val sessions: Int,
) {
    companion object {
        fun of(p: ProxyItem): Shown {
            val about = p.about
            val kind = about?.kind ?: when (p.last?.datacenter) {
                true -> Kind.Datacenter
                false -> Kind.Residential
                null -> Kind.Unknown
            }
            val cc = (about?.country ?: p.last?.cc)?.lowercase()
            val name = p.name?.takeIf { it.isNotBlank() } ?: about?.session?.let { "Session $it" } ?: p.address
            val where = listOfNotNull(about?.city, about?.region).firstOrNull()?.let(::spelled)
                ?: p.last?.place?.substringBefore(',')
                ?: countryName(cc)
            val minutes = about?.minutes?.let { "$it min" }
            val sub = when {
                about?.session != null -> listOfNotNull(where, minutes).joinToString(" · ").ifEmpty { p.address }
                p.name != null -> p.address
                else -> listOfNotNull(p.scheme?.uppercase(), where).joinToString(" · ").ifEmpty { "Your proxy" }
            }
            val line = listOfNotNull(kind.label, where ?: p.address.substringBefore(':')).joinToString(" · ")
            return Shown(PlaceRef.Proxy(p.id), name, kind, cc, line, sub, p.last?.latencyMs, 0)
        }

        fun of(g: GroupItem): Shown {
            val kind = g.shared.kind ?: Kind.Unknown
            val cc = g.shared.country?.lowercase()
            val count = if (g.sessions > 0) "${g.sessions} sessions" else "${g.size} proxies"
            val where = listOfNotNull(g.shared.city, g.shared.region).firstOrNull()?.let(::spelled) ?: countryName(cc)
            val minutes = g.shared.minutes?.let { "$it min" }
            val sub = listOfNotNull(count, where, minutes).joinToString(" · ")
            return Shown(PlaceRef.Group(g.id), g.name, kind, cc, "${kind.label} · $count", sub, null, g.sessions)
        }

        fun free(country: String, ms: Int? = null): Shown {
            val cc = country.lowercase().takeIf { it.length == 2 }
            val name = countryName(cc)?.let { "Free · $it" } ?: "Fastest free proxy"
            val sub = if (cc == null) "Any country · the fastest one" else "The fastest one there"
            // Under the name on the main screen, the words its row has in Connect to: the name
            // already says "Free · United States", and said twice it says nothing.
            return Shown(PlaceRef.Free(country), name, Kind.Free, cc, sub, sub, ms, 0)
        }

        /** One free proxy: the proxy itself (or the name it was given), where it is, how it is
         *  spoken to (2026-10-11: a city alone confuses, so the proxy itself shows too). */
        fun of(e: FreeExit, name: String? = null): Shown {
            val named = name?.takeIf { it.isNotBlank() }
            return Shown(
                e.ref,
                named ?: e.addr,
                e.kind,
                e.cc,
                line = listOfNotNull(e.kind.label.takeIf { e.kind != Kind.Unknown }, e.proto).joinToString(" · "),
                sub = if (named != null) "${e.addr} · ${e.where}" else "${e.where} · ${e.proto}",
                ms = e.ms,
                sessions = 0,
            )
        }

        /** A place by its reference, from the library; a free proxy from `free` (the list as
         *  last read), or by its address alone when the list does not hold it any more. */
        fun find(lib: Library, ref: PlaceRef?, freeExit: (String) -> FreeExit? = { null }, names: Map<String, String> = emptyMap()): Shown? = when (ref) {
            is PlaceRef.Proxy -> lib.proxies.find { it.id == ref.id }?.let(::of)
            is PlaceRef.Group -> lib.groups.find { it.id == ref.id }?.let(::of)
            is PlaceRef.Free -> when (val exit = ref.exit) {
                null -> free(ref.country)
                else -> freeExit(exit)?.let { of(it, names[exit]) } ?: Shown(
                    ref,
                    names[exit]?.takeIf { it.isNotBlank() } ?: exit,
                    Kind.Unknown,
                    ref.country.lowercase().takeIf { it.length == 2 },
                    line = if (ref.socks5) "SOCKS5" else "HTTP",
                    sub = listOfNotNull(countryName(ref.country.lowercase()), if (ref.socks5) "SOCKS5" else "HTTP").joinToString(" · "),
                    ms = null,
                    sessions = 0,
                )
            }
            null -> null
        }
    }
}
