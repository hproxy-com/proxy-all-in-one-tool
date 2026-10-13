package com.hproxy.app.state

import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.bool
import com.hproxy.app.engine.int
import com.hproxy.app.engine.jsonOf
import com.hproxy.app.engine.map
import com.hproxy.app.engine.objOrNull
import com.hproxy.app.engine.str
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/** How a checked proxy reads on its card (5 · Flip). */
enum class Face { Good, Slow, NoHttps, Reads, Blocked, Bad, Dead }

/** "Works with": any site, or one the person needs. */
enum class Site(val key: String, val label: String, val note: String) {
    Any("any", "Any site", "It opens the web, http and https"),
    Google("google", "Google", "Search answers without a captcha wall"),
    Instagram("instagram", "Instagram", "The app and the site load"),
    Tiktok("tiktok", "TikTok", "The app and the site load"),
    Amazon("amazon", "Amazon", "Shop pages load"),
}

/** One answer, as the engine sends it (proxy-engine/hproxy-mobile, checker.rs). */
data class Answer(
    val alive: Boolean,
    val carries: Boolean,
    val tone: String,
    val says: String,
    val why: String?,
    val notes: List<String>,
    val ms: Int?,
    val way: String?,
    val exitIp: String?,
    val cc: String?,
    val country: String?,
    val city: String?,
    val datacenter: Boolean?,
    val anonymity: String?,
    val protocols: List<String>,
    val error: String?,
    /** "opens", "refuses" or "unknown", when a site was asked. */
    val site: String?,
    val siteWhy: String?,
) {
    val face: Face
        get() = when {
            !alive -> Face.Dead
            site == "refuses" -> Face.Blocked
            "plain_http_only" in notes -> Face.NoHttps
            "reads_https" in notes -> Face.Reads
            !carries || tone == "bad" -> Face.Bad
            tone == "warn" -> Face.Slow
            else -> Face.Good
        }

    companion object {
        fun of(o: JSONObject): Answer {
            fun list(key: String): List<String> {
                val a = o.optJSONArray(key) ?: JSONArray()
                return (0 until a.length()).map { a.optString(it) }
            }
            val site = o.objOrNull("site")
            return Answer(
                alive = o.optBoolean("alive"),
                carries = o.optBoolean("carries"),
                tone = o.optString("tone"),
                says = o.optString("says"),
                why = o.str("why"),
                notes = list("notes"),
                ms = o.int("ms"),
                way = o.str("way"),
                exitIp = o.str("exitIp"),
                cc = o.str("cc"),
                country = o.str("country"),
                city = o.str("city"),
                datacenter = o.bool("datacenter"),
                anonymity = o.str("anonymity"),
                protocols = list("protocols"),
                error = o.str("error"),
                site = site?.str("verdict"),
                siteWhy = site?.str("why"),
            )
        }
    }
}

/** A card: one proxy of the run, face down until its answer lands. */
data class Card(
    val i: Int,
    val address: String,
    /** Where the proxy's own address is, for the flag face down. */
    val cc: String? = null,
    val answer: Answer? = null,
    /** When the answer landed (uptime millis), for the turn. */
    val landedAt: Long = 0,
)

enum class Stage { Ready, Running, Done }

data class Summary(val id: Long, val at: Long, val total: Int, val working: Int, val slow: Int, val bad: Int, val dead: Int)

data class Run(
    val id: Long,
    val cards: List<Card>,
    val stage: Stage,
    val site: Site,
    /** Lines that were not proxies, and repeats. */
    val invalid: Int,
    val repeated: Int,
    /** A saved group, when the run checks one: "Use" connects to it on that member. */
    val group: String? = null,
)

/**
 * The checker's state: the run on the screen, its cards as the answers land, and the recent runs.
 * The lines themselves stay in the engine; copying, sharing or saving asks for them.
 */
object CheckerState {
    private val runFlow = MutableStateFlow<Run?>(null)
    private val recentFlow = MutableStateFlow<List<Summary>>(emptyList())

    val run: StateFlow<Run?> = runFlow.asStateFlow()
    val recent: StateFlow<List<Summary>> = recentFlow.asStateFlow()

    /** Check pasted text, a saved group, every saved proxy, or a recent run again. */
    suspend fun start(text: String? = null, group: String? = null, saved: Boolean = false, again: Long? = null, site: Site = Site.Any): String? {
        // The judge the person chose (the checker's one choice, Settings.judge).
        val args = JSONObject().put("site", site.key).put("judge", Settings.judge.value.json())
        text?.let { args.put("text", it) }
        group?.let { args.put("group", it) }
        if (saved) args.put("saved", true)
        again?.let { args.put("again", it) }
        return try {
            val o = Engine.obj("checkStart", args)
            val items = (o.optJSONArray("items") ?: JSONArray()).map { Card(it.optInt("i"), it.optString("address")) }
            runFlow.value = Run(
                id = o.optLong("run"),
                cards = items,
                stage = Stage.Running,
                site = site,
                invalid = o.optInt("invalid"),
                repeated = o.optInt("repeated"),
                group = group,
            )
            null
        } catch (e: EngineError) {
            e.message
        }
    }

    suspend fun cancel() {
        try {
            Engine.call("checkCancel")
        } catch (e: EngineError) {
        }
        runFlow.value = runFlow.value?.copy(stage = Stage.Done)
    }

    fun reset() {
        runFlow.value = null
    }

    /** The lines of these cards, as they were pasted (for Copy, Share and Save as a group). */
    suspend fun lines(cards: List<Card>): List<String> {
        val r = runFlow.value ?: return emptyList()
        val which = JSONArray().apply { cards.forEach { put(it.i) } }
        return try {
            val a = Engine.arr("checkLines", jsonOf("run" to r.id, "which" to which))
            (0 until a.length()).map { a.getString(it) }
        } catch (e: EngineError) {
            emptyList()
        }
    }

    suspend fun refreshRecent() {
        try {
            recentFlow.value = Engine.arr("checkRecent").map {
                Summary(
                    it.optLong("id"),
                    it.optLong("at"),
                    it.optInt("total"),
                    it.optInt("working"),
                    it.optInt("slow"),
                    it.optInt("bad"),
                    it.optInt("dead"),
                )
            }
        } catch (e: EngineError) {
        }
    }

    fun onEvent(e: JSONObject) {
        val r = runFlow.value ?: return
        if (e.optBoolean("quiet") || e.optLong("run") != r.id) return
        when (e.optString("type")) {
            "check" -> {
                val row = e.optJSONObject("row") ?: return
                val i = row.optInt("i")
                val answer = Answer.of(row)
                val now = android.os.SystemClock.uptimeMillis()
                runFlow.value = r.copy(cards = r.cards.map { if (it.i == i) it.copy(answer = answer, landedAt = now) else it })
            }
            "checkGeo" -> {
                val items = e.optJSONArray("items") ?: return
                val cc = HashMap<Int, String>()
                for (k in 0 until items.length()) {
                    val o = items.getJSONObject(k)
                    cc[o.optInt("i")] = o.optString("cc")
                }
                runFlow.value = r.copy(cards = r.cards.map { c -> cc[c.i]?.let { c.copy(cc = it) } ?: c })
            }
            "checkDone" -> {
                runFlow.value = r.copy(stage = Stage.Done)
                AppState.scope.launch { refreshRecent() }
            }
        }
    }

}
