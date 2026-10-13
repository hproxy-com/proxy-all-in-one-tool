package com.hproxy.app.state

import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.FreeExit
import com.hproxy.app.engine.jsonOf
import com.hproxy.app.engine.map
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The free proxies, one a row (2026-10-11: the list itself, and which one you connect to): the pool's best exits of both protocols, every
 * country, read through the engine (`freeList`) when the Proxies screen first shows them, again
 * when asked, and kept for the screens that name a free proxy by its address (the bar, the
 * connection page) while it lasts.
 */
object FreeList {
    private val listFlow = MutableStateFlow<List<FreeExit>?>(null)
    private val errorFlow = MutableStateFlow<String?>(null)
    private val loadingFlow = MutableStateFlow(false)
    private var job: Job? = null
    /** When the list was read, for "checked a minute ago". */
    var readAt: Long = 0
        private set

    /** Null until the first read lands. */
    val list: StateFlow<List<FreeExit>?> = listFlow.asStateFlow()
    val error: StateFlow<String?> = errorFlow.asStateFlow()
    val loading: StateFlow<Boolean> = loadingFlow.asStateFlow()

    /** A free proxy by its "host:port", while the list holds it. */
    fun find(addr: String): FreeExit? = listFlow.value?.find { it.addr == addr }

    /** Read it, unless a read is under way, or one landed in the last minute (`force` reads anyway). */
    fun load(force: Boolean = false) {
        if (job?.isActive == true) return
        if (!force && listFlow.value != null && System.currentTimeMillis() - readAt < 60_000) return
        job = AppState.scope.launch {
            loadingFlow.value = true
            try {
                val rows = Engine.arr("freeList", jsonOf("limit" to 200)).map(FreeExit::of).filter { it.host.isNotEmpty() && it.port > 0 }
                listFlow.value = rows
                readAt = System.currentTimeMillis()
                errorFlow.value = null
            } catch (e: EngineError) {
                errorFlow.value = e.message ?: "The free list did not load"
            }
            loadingFlow.value = false
        }
    }

    /** The fastest free proxy a country has (any country when null), among those read: of the
     *  ones that answered nine checks in ten this week when there are any, so the one offered
     *  first is a proxy that tends to answer, not only a quick one. */
    fun fastest(country: String? = null): FreeExit? {
        val here = listFlow.value?.filter { country == null || it.cc == country } ?: return null
        val steady = here.filter { (it.uptime ?: 0.0) >= 0.9 }
        return (steady.ifEmpty { here }).minByOrNull { it.ms ?: Int.MAX_VALUE }
    }
}

/** One checker's answer about one address: its score, or why there is none. */
data class FraudAnswer(val score: Int?, val risk: String?, val error: String?)

/**
 * Fraud scores by address, from the checker the person turned on first (Settings, "Fraud score
 * checkers"); a proxy opened asks every checker that is on. Each address is asked once per
 * checker; asked again only when the app starts again. A screenful at a time: the rows on screen
 * ask for theirs.
 */
object FraudScores {
    private val scoresFlow = MutableStateFlow<Map<String, FraudAnswer>>(emptyMap())
    private val asked = HashSet<String>()

    /** By "<checker>|<address>". */
    val scores: StateFlow<Map<String, FraudAnswer>> = scoresFlow.asStateFlow()

    fun key(id: CheckerId, ip: String) = "${id.wire}|$ip"

    /** The checker every row shows: the first one that is on and can answer (FFraud unless the
     *  person turned it off). */
    fun headline(): CheckerId? = Settings.checkers.value.entries.firstOrNull { (id, set) -> set.answers(id) }?.key

    /** Ask `id` about these addresses, the ones not asked yet. */
    fun want(id: CheckerId, ips: List<String>) {
        val set = Settings.checkers.value[id] ?: return
        if (!set.answers(id)) return
        val fresh = synchronized(asked) { ips.distinct().filter { asked.add(key(id, it)) } }
        if (fresh.isEmpty()) return
        AppState.scope.launch {
            for (chunk in fresh.chunked(30)) {
                try {
                    val answers = Engine.arr("fraud", jsonOf("ips" to org.json.JSONArray(chunk), "service" to id.json(set.key)))
                    val next = scoresFlow.value.toMutableMap()
                    for (i in 0 until answers.length()) {
                        val o = answers.optJSONObject(i) ?: continue
                        val ip = o.optString("ip")
                        if (ip.isEmpty()) continue
                        next[key(id, ip)] = FraudAnswer(
                            score = if (o.has("score") && !o.isNull("score")) o.optInt("score") else null,
                            risk = o.optString("risk").ifEmpty { null },
                            error = o.optString("error").ifEmpty { null },
                        )
                    }
                    scoresFlow.value = next
                } catch (e: EngineError) {
                    // Asked again next time the screen wants it.
                    synchronized(asked) { chunk.forEach { asked.remove(key(id, it)) } }
                }
            }
        }
    }

    /** A checker's key changed or it was turned on: what it said before no longer counts. */
    fun forget(id: CheckerId) {
        synchronized(asked) { asked.removeAll { it.startsWith("${id.wire}|") } }
        scoresFlow.value = scoresFlow.value.filterKeys { !it.startsWith("${id.wire}|") }
    }
}
