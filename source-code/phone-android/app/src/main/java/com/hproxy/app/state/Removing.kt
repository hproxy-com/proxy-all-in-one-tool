package com.hproxy.app.state

import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.jsonOf
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Delete many, then Restore for five seconds, as on the computer (lib/undoRemove.ts): a long list is
 * easy to delete by mistake. The proxies leave the list at once and are forgotten when the time is
 * up, so nothing has to be put back; a new delete finishes the one before.
 */
object Removing {
    private const val RESTORE_MS = 5000L
    private val waitingFlow = MutableStateFlow<Set<String>>(emptySet())
    private var timer: Job? = null

    /** The proxies out of the list, waiting to be forgotten. */
    val waiting: StateFlow<Set<String>> = waitingFlow.asStateFlow()

    fun remove(ids: Set<String>) {
        if (ids.isEmpty()) return
        finish()
        waitingFlow.value = waitingFlow.value + ids
        timer = AppState.scope.launch {
            delay(RESTORE_MS)
            finish()
        }
    }

    fun restore() {
        timer?.cancel()
        waitingFlow.value = emptySet()
    }

    private fun finish() {
        timer?.cancel()
        val ids = waitingFlow.value
        if (ids.isEmpty()) return
        AppState.scope.launch {
            var library: JSONObject? = null
            for (id in ids) {
                try {
                    library = Engine.obj("forget", jsonOf("id" to id))
                    JustAdded.forget(id)
                } catch (e: EngineError) {
                    AppState.toast(e.message ?: "It was not removed")
                }
            }
            library?.let(AppState::setLibrary)
            waitingFlow.value = waitingFlow.value - ids
        }
    }
}
