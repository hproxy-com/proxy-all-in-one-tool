package com.hproxy.app.engine

import android.content.Context
import android.os.Build
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** The engine said no, in words for the person. */
class EngineError(message: String) : Exception(message)

/**
 * The engine, for the rest of the app: started once per process, called with a method name and
 * JSON, its events read on a thread of their own and handed on as a flow.
 *
 * A call that waits for the network (connecting, a probe, the speed test) waits on the IO
 * dispatcher, never on the screen's thread.
 */
object Engine {
    private const val TAG = "HProxy"
    private val started = AtomicBoolean(false)
    private val pumping = AtomicBoolean(false)
    private val eventFlow = MutableSharedFlow<JSONObject>(extraBufferCapacity = 512)

    /** What happens in the engine on its own: probes, checker answers, blocked apps, the tunnel. */
    val events: SharedFlow<JSONObject> = eventFlow.asSharedFlow()

    fun start(context: Context) {
        if (!started.compareAndSet(false, true)) return
        val answer = Native.init(context.filesDir.absolutePath, Build.VERSION.SDK_INT)
        read(answer)
        if (pumping.compareAndSet(false, true)) {
            Thread({
                while (true) {
                    val e = try {
                        Native.poll(2000)
                    } catch (t: Throwable) {
                        Log.e(TAG, "events: reading failed", t)
                        null
                    }
                    if (e != null) {
                        try {
                            eventFlow.tryEmit(JSONObject(if (Pictures.on) Pictures.out(e) else e))
                        } catch (t: Throwable) {
                            Log.w(TAG, "events: one could not be read", t)
                        }
                    }
                }
            }, "hproxy-events").apply { isDaemon = true }.start()
        }
    }

    /** One call, waiting off the screen's thread. */
    suspend fun call(method: String, args: JSONObject? = null): Any? =
        withContext(Dispatchers.IO) { callNow(method, args) }

    /** One call on the thread that calls it (services, which have no screen to keep moving). */
    fun callNow(method: String, args: JSONObject? = null): Any? {
        val text = args?.toString() ?: ""
        return read(Native.call(method, if (Pictures.on) Pictures.into(text) else text))
    }

    suspend fun obj(method: String, args: JSONObject? = null): JSONObject =
        call(method, args) as? JSONObject ?: JSONObject()

    suspend fun arr(method: String, args: JSONObject? = null): JSONArray =
        call(method, args) as? JSONArray ?: JSONArray()

    /** The value of an answer, or the engine's words as an error. */
    internal fun read(answer: String): Any? {
        val o = JSONObject(if (Pictures.on) Pictures.out(answer) else answer)
        if (o.optBoolean("ok")) {
            val v = o.opt("value")
            return if (v == JSONObject.NULL) null else v
        }
        throw EngineError(o.optString("error", "something went wrong"))
    }
}

/** Small helpers for the engine's JSON. */
internal fun JSONObject.str(key: String): String? =
    if (has(key) && !isNull(key)) optString(key).takeIf { it.isNotEmpty() } else null

internal fun JSONObject.int(key: String): Int? = if (has(key) && !isNull(key)) optInt(key) else null

internal fun JSONObject.long(key: String): Long? = if (has(key) && !isNull(key)) optLong(key) else null

internal fun JSONObject.dbl(key: String): Double? = if (has(key) && !isNull(key)) optDouble(key) else null

internal fun JSONObject.bool(key: String): Boolean? = if (has(key) && !isNull(key)) optBoolean(key) else null

internal fun JSONObject.objOrNull(key: String): JSONObject? = if (has(key) && !isNull(key)) optJSONObject(key) else null

internal inline fun <T> JSONArray.map(f: (JSONObject) -> T): List<T> =
    (0 until length()).mapNotNull { optJSONObject(it) }.map(f)

internal fun jsonOf(vararg pairs: Pair<String, Any?>): JSONObject =
    JSONObject().apply { for ((k, v) in pairs) put(k, v ?: JSONObject.NULL) }
