package com.hproxy.app.state

import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.jsonOf
import com.hproxy.app.engine.map
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * The proxies added since the app started, newest first: they head My proxies under "Just added"
 * and are checked from this phone at once, quietly (the engine's quiet run: it never replaces the
 * Checker tab's run and never joins its recent checks). Each row says "Checking from this phone"
 * until its own answer lands, then shows where it is and how fast (2026-10-11: each can be named,
 * or the naming skipped; the naming happens while they are checked).
 */
object JustAdded {
    private val idsFlow = MutableStateFlow<List<String>>(emptyList())
    private val checkingFlow = MutableStateFlow<Set<String>>(emptySet())
    private val answersFlow = MutableStateFlow<Map<String, Answer>>(emptyMap())
    /** Per quiet run: its rows by their place in it, as proxy ids. */
    private val runs = HashMap<Long, Map<Int, String>>()
    /** Answers of a quiet run that landed before its start was answered (a line that fails at
     *  once can): kept a moment, read once the run is known. */
    private val early = ArrayList<JSONObject>()

    val ids: StateFlow<List<String>> = idsFlow.asStateFlow()
    /** Still being checked. */
    val checking: StateFlow<Set<String>> = checkingFlow.asStateFlow()
    /** What the check found, by proxy id, from the moment it lands (the library has it once the
     *  run is over). */
    val answers: StateFlow<Map<String, Answer>> = answersFlow.asStateFlow()

    /** New proxies, by id, in the order of the paste: on top, and checked now. */
    fun added(fresh: List<String>) {
        if (fresh.isEmpty()) return
        idsFlow.value = fresh + idsFlow.value.filterNot { it in fresh }
        checkingFlow.value = checkingFlow.value + fresh
        answersFlow.value = answersFlow.value - fresh.toSet()
        AppState.scope.launch {
            try {
                val o = Engine.obj(
                    "checkStart",
                    jsonOf("ids" to JSONArray(fresh), "quiet" to true, "judge" to Settings.judge.value.json()),
                )
                val lib = AppState.library.value
                val byAddress = lib.proxies.filter { it.id in fresh }.associate { it.address to it.id }
                val rows = (o.optJSONArray("items") ?: JSONArray()).map { it.optInt("i") to it.optString("address") }
                val index = rows.mapNotNull { (i, address) -> byAddress[address]?.let { i to it } }.toMap()
                val run = o.optLong("run")
                runs[run] = index
                // Lines the engine could not read as a proxy are not checked: nothing to wait for.
                val waiting = index.values.toSet()
                checkingFlow.value = checkingFlow.value - fresh.filterNot { it in waiting }.toSet()
                val mine = early.filter { it.optLong("run") == run }
                early.removeAll(mine.toSet())
                mine.forEach(::onEvent)
            } catch (e: EngineError) {
                checkingFlow.value = checkingFlow.value - fresh.toSet()
            }
        }
    }

    /** A proxy forgotten: it leaves the list. */
    fun forget(id: String) {
        idsFlow.value = idsFlow.value - id
        checkingFlow.value = checkingFlow.value - id
    }

    /** "check" and "checkDone" of a quiet run (AppState.onEvent). */
    fun onEvent(e: JSONObject) {
        if (!e.optBoolean("quiet")) return
        val run = e.optLong("run")
        val index = runs[run] ?: run {
            // Another screen's quiet run, or this one's before its start was answered.
            if (early.size >= 400) early.removeAt(0)
            early.add(e)
            return
        }
        when (e.optString("type")) {
            "check" -> {
                val row = e.optJSONObject("row") ?: return
                val id = index[row.optInt("i")] ?: return
                answersFlow.value = answersFlow.value + (id to Answer.of(row))
                checkingFlow.value = checkingFlow.value - id
            }
            "checkDone" -> {
                runs.remove(run)
                checkingFlow.value = checkingFlow.value - index.values.toSet()
                // The answers are kept on the proxies now: the library has them.
                AppState.scope.launch { AppState.refreshLibrary() }
            }
        }
    }
}
