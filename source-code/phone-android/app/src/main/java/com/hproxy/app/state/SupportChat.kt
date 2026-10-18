package com.hproxy.app.state

import android.os.Build
import com.hproxy.app.BuildConfig
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.jsonOf
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Help tab: talking to HProxy support (2026-10-11: support in the app, and an idea goes to the
 * same chat). The engine holds the socket to chat.hproxy.com
 * (proxy-engine/hproxy-mobile/src/chat.rs) and tells what happens through "chat" events; this keeps
 * the thread for the screen. The chat shows "HProxy support" and its people, nothing else: no
 * company, no address.
 */
object SupportChat {
    enum class Sent { Sending, Delivered, Read, Failed }

    data class Msg(
        /** The server's id, or (until it answered) the app's own. */
        val id: String,
        val mine: Boolean,
        val body: String,
        /** Milliseconds since 1970. */
        val at: Long,
        val sent: Sent = Sent.Delivered,
        /** Who answered, when the chat names a person. */
        val by: String? = null,
    )

    data class Intro(val name: String?, val greeting: String?, val welcome: String?, val replyTime: String?)

    enum class Link { Closed, Opening, Open, Down }

    private val messagesFlow = MutableStateFlow<List<Msg>>(emptyList())
    private val linkFlow = MutableStateFlow(Link.Closed)
    private val onlineFlow = MutableStateFlow(false)
    private val typingFlow = MutableStateFlow(false)
    private val introFlow = MutableStateFlow<Intro?>(null)
    private val draftFlow = MutableStateFlow("")
    private var conversation: String? = null
    private var counter = 0

    val messages: StateFlow<List<Msg>> = messagesFlow.asStateFlow()
    val link: StateFlow<Link> = linkFlow.asStateFlow()
    /** Someone from support is there now. */
    val online: StateFlow<Boolean> = onlineFlow.asStateFlow()
    val typing: StateFlow<Boolean> = typingFlow.asStateFlow()
    val intro: StateFlow<Intro?> = introFlow.asStateFlow()
    /** What the box holds: "Idea: " after Settings' "Send an idea". */
    val draft: StateFlow<String> = draftFlow.asStateFlow()

    fun setDraft(text: String) {
        draftFlow.value = text
    }

    /** Open the chat (Help showing): the person's own thread comes back with its token. Support
     *  sees where it was written from: this app, its store and its version (2026-10-18). */
    fun open() {
        if (linkFlow.value == Link.Open || linkFlow.value == Link.Opening) return
        linkFlow.value = Link.Opening
        AppState.scope.launch {
            try {
                Engine.call("chatOpen", jsonOf("token" to Settings.chatToken, "store" to store(), "version" to BuildConfig.VERSION_NAME))
            } catch (e: EngineError) {
                linkFlow.value = Link.Down
            }
        }
    }

    /** Where this copy of the app came from, for support (2026-10-18): "google-play"; "apk" when
     *  it was installed by hand (the APK from the website); a known store by its name; else the
     *  installer's own package. Null when the phone will not say. */
    private fun store(): String? = runCatching {
        val pm = AppState.app.packageManager
        val name = AppState.app.packageName
        val installer = if (Build.VERSION.SDK_INT >= 30) {
            pm.getInstallSourceInfo(name).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            pm.getInstallerPackageName(name)
        }
        when (installer) {
            "com.android.vending" -> "google-play"
            null, "com.google.android.packageinstaller", "com.android.packageinstaller" -> "apk"
            "com.sec.android.app.samsungapps" -> "galaxy-store"
            "com.amazon.venezia" -> "amazon-appstore"
            "com.huawei.appmarket" -> "appgallery"
            else -> installer
        }
    }.getOrNull()

    /** Send what the box holds. It shows at once, "Sending" until the chat has it. */
    fun send(text: String): Boolean {
        val body = text.trim()
        if (body.isEmpty()) return false
        val id = "app-${System.currentTimeMillis()}-${counter++}"
        messagesFlow.value = messagesFlow.value + Msg(id, mine = true, body = body, at = System.currentTimeMillis(), sent = Sent.Sending)
        draftFlow.value = ""
        AppState.scope.launch {
            try {
                Engine.call("chatSend", jsonOf("id" to id, "body" to body))
            } catch (e: EngineError) {
                mark(id) { it.copy(sent = Sent.Failed) }
                open()
            }
        }
        return true
    }

    /** Send a message again that did not go. */
    fun retry(m: Msg) {
        messagesFlow.value = messagesFlow.value.filterNot { it.id == m.id }
        send(m.body)
    }

    /** The person read the thread: support sees it. */
    fun read() {
        val c = conversation ?: return
        AppState.scope.launch {
            try {
                Engine.call("chatRead", jsonOf("conversationId" to c))
            } catch (e: EngineError) {
                // Not open: read once it is.
            }
        }
    }

    private fun mark(id: String, f: (Msg) -> Msg) {
        messagesFlow.value = messagesFlow.value.map { if (it.id == id) f(it) else it }
    }

    private fun msgOf(o: JSONObject): Msg? {
        val body = o.optString("body").ifEmpty { return null }
        if (o.optBoolean("is_internal")) return null
        val mine = o.optString("author_type") == "visitor"
        val named = o.optString("author_name").ifEmpty { null }
        return Msg(
            id = o.optString("id"),
            mine = mine,
            body = body,
            at = parseTime(o.optString("created_at")),
            sent = if (mine && !o.isNull("read_by_agent_at") && o.has("read_by_agent_at")) Sent.Read else Sent.Delivered,
            by = if (mine) null else named,
        )
    }

    /** "2026-10-11T18:42:55.399470Z" to the second. Not java.time: Android 7 has none. */
    private fun parseTime(s: String): Long = try {
        val f = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
        f.timeZone = java.util.TimeZone.getTimeZone("UTC")
        f.parse(s.take(19))?.time ?: System.currentTimeMillis()
    } catch (e: Exception) {
        System.currentTimeMillis()
    }

    /** One "chat" event from the engine (AppState.onEvent). */
    fun onEvent(e: JSONObject) {
        when (e.optString("kind")) {
            "ready" -> {
                linkFlow.value = Link.Open
                e.optString("token").ifEmpty { null }?.let { Settings.chatToken = it }
                conversation = e.optString("conversation").ifEmpty { null }
                onlineFlow.value = e.optBoolean("online")
                introFlow.value = Intro(
                    name = e.optString("name").ifEmpty { null },
                    greeting = e.optString("greeting").ifEmpty { null },
                    welcome = e.optString("welcome").ifEmpty { null },
                    replyTime = e.optString("replyTime").ifEmpty { null },
                )
            }
            "history" -> {
                val arr = e.optJSONArray("messages") ?: JSONArray()
                val old = (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let(::msgOf) }
                // Messages still on their way stay after the thread as the chat keeps it.
                val pending = messagesFlow.value.filter { it.sent == Sent.Sending || it.sent == Sent.Failed }
                messagesFlow.value = old + pending.filter { p -> old.none { it.body == p.body && it.mine } }
            }
            "message" -> {
                val m = e.optJSONObject("message")?.let(::msgOf) ?: return
                if (messagesFlow.value.none { it.id == m.id }) messagesFlow.value = messagesFlow.value + m
                if (!m.mine) typingFlow.value = false
                e.optJSONObject("message")?.optString("conversation_id")?.ifEmpty { null }?.let { conversation = it }
            }
            "ack" -> {
                val a = e.optJSONObject("ack") ?: return
                val id = a.optString("id")
                val server = a.optString("server_id").ifEmpty { null }
                a.optString("conversation_id").ifEmpty { null }?.let { conversation = it }
                when (a.optString("state")) {
                    "delivered" -> mark(id) { it.copy(id = server ?: it.id, sent = Sent.Delivered) }
                    "read" -> mark(server ?: id) { it.copy(sent = Sent.Read) }
                }
            }
            "conversation" -> e.optJSONObject("conversation")?.optString("id")?.ifEmpty { null }?.let { conversation = it }
            "typing" -> typingFlow.value = e.optBoolean("on")
            "online" -> onlineFlow.value = e.optBoolean("online")
            "deleted" -> {
                val id = e.optString("id")
                messagesFlow.value = messagesFlow.value.filterNot { it.id == id }
            }
            "down" -> {
                if (linkFlow.value != Link.Closed) linkFlow.value = Link.Down
                typingFlow.value = false
            }
            "error" -> {
                val id = e.optString("id")
                if (id.startsWith("app-")) mark(id) { it.copy(sent = Sent.Failed) }
            }
        }
    }
}
