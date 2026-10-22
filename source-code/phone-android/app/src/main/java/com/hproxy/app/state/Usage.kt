package com.hproxy.app.state

import android.util.Log
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.jsonOf
import java.util.Collections
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Usage counts (proxy-engine/hproxy-api, usage.rs, through the engine's usage calls): a switch in
 * Settings with the last report exactly as it went, and nothing counted, written or sent before it
 * is on. Never asked in a sheet since 2026-10-22 (ui/settings/UsagePage.kt), the computer app the
 * same. The engine counts what happens in it (connections, checks, what is saved);
 * the app tells it only what the screens alone see: an opening, a search, a crash of the screens.
 * What a report holds: PRIVACY.md, "Usage counts".
 */
object Usage {
    private const val TAG = "HProxy"

    enum class Answer { Unasked, Yes, No }

    /** The answer, and the last report as it was sent (null before the first). */
    data class View(val answer: Answer, val last: JSONObject?)

    /** What a report holds, in the words the question and Settings show. */
    val HOLDS = listOf(
        "How often HProxy was opened",
        "How many connections worked, and why the others failed",
        "How many checks ran, and how long the lists were, roughly",
        "How many proxies and groups you keep, roughly",
        "Which features you used",
        "How often a part of the app crashed",
    )
    const val NEVER = "Never a proxy, a login, a site you visit, a name, a note or anything else you type."

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val viewFlow = MutableStateFlow<View?>(null)
    val view: StateFlow<View?> = viewFlow.asStateFlow()

    private fun read(o: JSONObject): View {
        val answer = when (o.optString("answer")) {
            "yes" -> Answer.Yes
            "no" -> Answer.No
            else -> Answer.Unasked
        }
        return View(answer, o.optJSONObject("last"))
    }

    /** The answer as the engine keeps it. */
    fun load() {
        scope.launch {
            try {
                viewFlow.value = read(Engine.obj("usage"))
            } catch (e: EngineError) {
                Log.w(TAG, "usage: ${e.message}")
            }
        }
    }

    /** Yes or no. No deletes this copy's number and every count; a later yes makes a new number. */
    fun answer(yes: Boolean) {
        scope.launch {
            try {
                viewFlow.value = read(Engine.obj("usageAnswer", jsonOf("yes" to yes)))
            } catch (e: EngineError) {
                AppState.toast(e.message ?: "That did not work")
            }
        }
    }

    /** The app opened (a start of its screen, never a turn of the phone). */
    fun opened() = tell(jsonOf("kind" to "opened"))

    /** A feature only the screens see, by its fixed name (hproxy-api, `usage::FEATURES`); once a run. */
    private val said = Collections.synchronizedSet(mutableSetOf<String>())

    fun feature(name: String) {
        if (said.add(name)) tell(jsonOf("kind" to "feature", "name" to name))
    }

    private fun tell(event: JSONObject) {
        scope.launch {
            try {
                Engine.call("usageCount", jsonOf("event" to event))
            } catch (e: EngineError) {
                Log.w(TAG, "usage: ${e.message}")
            }
        }
    }

    /** The screens crashed: counted at once, on the dying thread (only the count, never the error). */
    fun crashedNow() {
        try {
            Engine.callNow("usageCount", jsonOf("event" to jsonOf("kind" to "crash", "part" to "window")))
        } catch (_: Throwable) {
            // The engine may not be up yet; nothing else to do on the way out.
        }
    }

    /** The finished days that wait, sent once each. Blocks: call it on a thread of its own. */
    fun sendNow() {
        try {
            Engine.callNow("usageSend")
        } catch (e: EngineError) {
            Log.w(TAG, "usage: ${e.message}")
        }
    }
}
