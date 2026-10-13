package com.hproxy.app.migrate

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import android.webkit.WebView
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.state.AppState
import com.hproxy.app.state.Settings
import java.io.File
import kotlin.coroutines.resume
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

/**
 * The saved proxies of the app this one replaces (0.2.5 on Google Play kept them in its web
 * view's storage, desktop-app/src/lib/windowStorage.ts), moved into the library once, so nobody
 * who updates loses a proxy. Read the way the old app read them: a page of the old app's own
 * address reads its storage, in a web view nobody sees. The old keys are left where they are,
 * as the computer app leaves them.
 */
object OldAppStorage {
    private const val TAG = "HProxy"
    /** The old app's addresses on Android (Tauri 2 served its page from these). */
    private val ORIGINS = listOf("http://tauri.localhost/", "https://tauri.localhost/")
    private const val READ = """(function(){
        function r(k){ try { return localStorage.getItem(k); } catch (e) { return null; } }
        return JSON.stringify({
          saved: r('hproxy-checker-saved-proxies'),
          lists: r('hproxy-checker-saved-lists'),
          target: r('hproxy-checker-connect-target')
        });
      })()"""

    /** How long the old app's storage may take to answer. A phone's first web view can take many
     *  seconds to start: 8 were not enough on an emulator (2026-10-09), and the move was lost. */
    private const val READ_BUDGET_MS = 30_000L

    /**
     * Once, on a phone that had the old app: a web view only when its storage is there. The move is
     * recorded only after the storage answered in full. One that did not answer in time (a slow
     * first web view, one being updated) is asked again on the next start: a slow phone never
     * costs anyone a proxy.
     */
    suspend fun moveIfThere(context: Context) {
        if (Settings.lookedForOldProxies) return
        val lib = AppState.library.value
        if (lib.movedFromWindow) {
            Settings.lookedForOldProxies = true
            return
        }
        val webData = File(context.applicationInfo.dataDir, "app_webview")
        val storage = if (webData.exists()) {
            withTimeoutOrNull(READ_BUDGET_MS) { readAll(context) } ?: run {
                Log.w(TAG, "old proxies: the earlier app's storage did not answer; asked again on the next start")
                return
            }
        } else {
            null
        }
        try {
            val o = Engine.obj("moveFromWindow", JSONObject().put("storage", storage ?: JSONObject()))
            o.optJSONObject("library")?.let(AppState::setLibrary)
            val saved = storage?.optJSONArray("saved")?.length() ?: 0
            val lists = storage?.optJSONArray("lists")?.length() ?: 0
            // Counts only: never a line or a password in the log.
            Log.i(TAG, "old proxies: moved=${o.optBoolean("moved")}, $saved saved, $lists lists")
            if (o.optBoolean("moved") && saved + lists > 0) {
                AppState.toast("Your saved proxies from the earlier app are here.")
            }
            Settings.lookedForOldProxies = true
        } catch (e: EngineError) {
            Log.w(TAG, "old proxies: ${e.message}")
        }
    }

    /** Both of the old app's addresses at once, merged: null unless both answered (then it is
     *  asked again), empty when both answered with nothing. */
    private suspend fun readAll(context: Context): JSONObject? {
        val answers = coroutineScope { ORIGINS.map { origin -> async { readAt(context, origin) } }.awaitAll() }
        if (answers.any { it == null }) return null
        val saved = JSONArray()
        val lists = JSONArray()
        var target: Any? = null
        for (raw in answers) {
            val o = try {
                JSONObject(raw!!)
            } catch (e: Exception) {
                return null
            }
            fun parsed(key: String): Any? = o.optString(key).takeIf { it.isNotEmpty() && it != "null" }?.let {
                try {
                    if (it.trim().startsWith("[")) JSONArray(it) else JSONObject(it)
                } catch (e: Exception) {
                    null
                }
            }
            (parsed("saved") as? JSONArray)?.let { a -> for (i in 0 until a.length()) saved.put(a.get(i)) }
            (parsed("lists") as? JSONArray)?.let { a -> for (i in 0 until a.length()) lists.put(a.get(i)) }
            if (target == null) target = parsed("target") as? JSONObject
        }
        return JSONObject().put("saved", saved).put("lists", lists).put("target", target ?: JSONObject.NULL)
    }

    /** One address's storage as the read script writes it, or null when it gave no answer. */
    @SuppressLint("SetJavaScriptEnabled")
    private suspend fun readAt(context: Context, origin: String): String? = suspendCancellableCoroutine { cont ->
        val web = try {
            WebView(context)
        } catch (e: Exception) {
            // No web view right now (missing, or being updated): no answer, asked again later.
            Log.w(TAG, "old proxies: no web view (${e.javaClass.simpleName})")
            cont.resume(null)
            return@suspendCancellableCoroutine
        }
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = object : android.webkit.WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                view.evaluateJavascript(READ) { result ->
                    // evaluateJavascript hands back a JSON string literal. Anything but the object
                    // the script makes (a script that failed hands back null) is no answer.
                    val text = try {
                        JSONArray("[$result]").optString(0)
                    } catch (e: Exception) {
                        null
                    }
                    web.destroy()
                    if (cont.isActive) cont.resume(text?.takeIf { it.trimStart().startsWith("{") })
                }
            }
        }
        web.loadDataWithBaseURL(origin, "<!doctype html><title>HProxy</title>", "text/html", "utf-8", null)
        cont.invokeOnCancellation { web.destroy() }
    }
}
