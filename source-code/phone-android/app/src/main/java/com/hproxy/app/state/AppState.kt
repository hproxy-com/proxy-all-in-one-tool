package com.hproxy.app.state

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.Health
import com.hproxy.app.engine.Library
import com.hproxy.app.engine.PlaceRef
import com.hproxy.app.engine.Shown
import com.hproxy.app.engine.Status
import com.hproxy.app.engine.jsonOf
import com.hproxy.app.engine.str
import com.hproxy.app.firewall.Firewall
import com.hproxy.app.firewall.Net
import com.hproxy.app.vpn.Vpn
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/** Where the connection is, as the main screen says it. */
sealed class Phase {
    data object Off : Phase()
    /** Step 0 "Reaching the proxy", step 1 "Checking where you appear"; `to` the proxy being
     *  connected, so its row and the nav say so before the engine has answered. */
    data class Connecting(val step: Int, val to: PlaceRef? = null, val member: Int? = null) : Phase()
    data object On : Phase()
    /** Connected, moving to [to]: the screen flies there from the tap on, not once the engine
     *  has answered. */
    data class Switching(val to: PlaceRef, val member: Int? = null) : Phase()
}

/** The phone's own address, while off ("84.17.••.•••", "Your own IP"). */
data class OwnIp(val ip: String, val cc: String?, val city: String?, val timezone: String?)

/** Download and upload, per second, while connected. */
data class Rates(val down: Long = 0, val up: Long = 0)

/** A proxy that did not answer when it was picked: its row says so, nothing else is taken
 *  instead (2026-10-11: a pick that changed by itself read as random). */
data class Failed(val ref: PlaceRef, val why: String, val member: Int? = null)

/**
 * The app's state, once per process: the library, the connection and its health, and the actions
 * that change them. The screens draw from it, and the VPN service, the quick tile and the boot
 * receiver act through it, so a connection started anywhere looks the same everywhere. It keeps
 * the application's context only, which lives as long as the process: nothing leaks.
 */
@SuppressLint("StaticFieldLeak")
object AppState {
    private const val TAG = "HProxy"
    lateinit var app: Context
        private set
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val libraryFlow = MutableStateFlow(Library())
    private val statusFlow = MutableStateFlow(Status.OFF)
    private val phaseFlow = MutableStateFlow<Phase>(Phase.Off)
    private val healthFlow = MutableStateFlow<Health?>(null)
    private val ownIpFlow = MutableStateFlow<OwnIp?>(null)
    private val ratesFlow = MutableStateFlow(Rates())
    private val netFlow = MutableStateFlow(Net.Other)
    private val toastFlow = MutableSharedFlow<String>(extraBufferCapacity = 8)
    private val fallenBackFlow = MutableStateFlow(false)
    private val failedFlow = MutableStateFlow<Failed?>(null)
    /** The place picked last that did not answer (cleared by the next pick). */
    val failed: StateFlow<Failed?> = failedFlow.asStateFlow()
    /** The connection as a list row reads it (Conn.kt): changes only when a row would. */
    val conn: StateFlow<Conn> = combine(phaseFlow, statusFlow, healthFlow, failedFlow) { phase, s, h, f ->
        Conn(
            phase = phase,
            running = s.running,
            place = s.place?.key,
            member = s.member,
            since = s.startedAtMs,
            stopped = h != null && !h.ok && h.failuresInARow >= 2,
            failed = f,
        )
    }.distinctUntilChanged().stateIn(scope, SharingStarted.Eagerly, Conn())

    val library: StateFlow<Library> = libraryFlow.asStateFlow()
    val status: StateFlow<Status> = statusFlow.asStateFlow()
    val phase: StateFlow<Phase> = phaseFlow.asStateFlow()
    val health: StateFlow<Health?> = healthFlow.asStateFlow()
    val ownIp: StateFlow<OwnIp?> = ownIpFlow.asStateFlow()
    val rates: StateFlow<Rates> = ratesFlow.asStateFlow()
    val net: StateFlow<Net> = netFlow.asStateFlow()
    val toasts: SharedFlow<String> = toastFlow.asSharedFlow()
    /** The proxy stopped answering and "If it drops" says use your own: the phone is out of
     *  the VPN until the proxy answers again. */
    val fallenBack: StateFlow<Boolean> = fallenBackFlow.asStateFlow()

    /** The person wants the proxy on (the switch), whatever the proxy itself does. */
    @Volatile var wanted = false
        private set
    private var connecting: Job? = null
    private var ticker: Job? = null

    fun start(context: Context) {
        if (::app.isInitialized) return
        app = context.applicationContext
        Settings.load(app)
        Engine.start(app)
        scope.launch { Engine.events.collect { onEvent(it) } }
        scope.launch {
            refreshLibrary()
            val s = statusNow()
            if (s.running) {
                // The process came back while the engine was still connected (it never stops
                // without the app): show it as it is.
                wanted = true
                phaseFlow.value = Phase.On
                startTicker()
            }
            refreshOwnIp()
        }
    }

    fun toast(text: String) {
        toastFlow.tryEmit(text)
    }

    // ---------------------------------------------------------------------------------------
    // The library
    // ---------------------------------------------------------------------------------------

    suspend fun refreshLibrary(): Library {
        val lib = try {
            Library.of(Engine.obj("library"))
        } catch (e: EngineError) {
            Log.e(TAG, "library", e)
            return libraryFlow.value
        }
        libraryFlow.value = lib
        lib.notice?.let(::toast)
        return lib
    }

    fun setLibrary(o: JSONObject) {
        libraryFlow.value = Library.of(o)
    }

    /** The place the switch connects to: the one connected through, else the one picked last. */
    fun current(): Shown? = show(target())

    /** The place every screen shows as "the connection": the one being connected or switched to,
     *  else the one in use, else the one that just did not answer (its row and the nav say so, and
     *  the switch tries it again), else the one picked last. */
    fun target(): PlaceRef? = when (val p = phaseFlow.value) {
        is Phase.Switching -> p.to
        is Phase.Connecting -> p.to
        else -> null
    } ?: statusFlow.value.place ?: failedFlow.value?.ref ?: libraryFlow.value.picked

    /** What the nav's switch connects: the place above, else the fastest free proxy (named, so
     *  the switch never takes a random one). */
    fun switchTarget(): PlaceRef? = target() ?: FreeList.fastest()?.ref

    /** A place as the screens show it: a free proxy by its row in the free list and the name it
     *  was given, a saved one from the library. */
    fun show(ref: PlaceRef?): Shown? = Shown.find(libraryFlow.value, ref, FreeList::find, Settings.freeNames.value)

    // ---------------------------------------------------------------------------------------
    // The connection
    // ---------------------------------------------------------------------------------------

    private suspend fun statusNow(): Status = try {
        Status.of(Engine.obj("status")).also { statusFlow.value = it }
    } catch (e: EngineError) {
        statusFlow.value
    }

    /**
     * Connect to [place] (a group starting on [member]), or switch to it while connected. The
     * VPN permission must have been given already (MainActivity asks; the tile and the boot
     * receiver only connect when it was).
     */
    fun connect(place: PlaceRef, member: Int? = null) {
        if (wanted && statusFlow.value.running) {
            switchTo(place, member)
            return
        }
        connecting?.cancel()
        failedFlow.value = null
        connecting = scope.launch {
            wanted = true
            fallenBackFlow.value = false
            healthFlow.value = null
            phaseFlow.value = Phase.Connecting(0, place, member)
            try {
                val s = Status.of(Engine.obj("connect", jsonOf("place" to place.json(), "member" to member)))
                statusFlow.value = s
                refreshLibrary()
                if (!wanted) return@launch
                phaseFlow.value = Phase.Connecting(1, place, member)
                if (!Vpn.apply(app)) {
                    wanted = false
                    Engine.call("disconnect")
                    statusFlow.value = Status.OFF
                    phaseFlow.value = Phase.Off
                    toast("Android did not let HProxy open its VPN. Connect again to allow it.")
                    return@launch
                }
                Settings.connectedInBoot = Settings.bootCount(app)
                // "Working" only once a probe through it came back (or a few seconds passed:
                // then the screen says what the probe says when it lands).
                withTimeoutOrNull(9000) { healthFlow.first { it != null } }
                if (wanted) {
                    phaseFlow.value = Phase.On
                    startTicker()
                }
            } catch (e: EngineError) {
                wanted = false
                phaseFlow.value = Phase.Off
                statusFlow.value = Status.OFF
                failedFlow.value = Failed(place, e.message ?: "It did not answer", member)
                toast(e.message ?: "Could not connect")
            }
        }
    }

    private fun switchTo(place: PlaceRef, member: Int?) {
        connecting?.cancel()
        failedFlow.value = null
        connecting = scope.launch {
            phaseFlow.value = Phase.Switching(place, member)
            healthFlow.value = null
            try {
                val s = Status.of(Engine.obj("connect", jsonOf("place" to place.json(), "member" to member)))
                statusFlow.value = s
                refreshLibrary()
                Vpn.apply(app)
                withTimeoutOrNull(9000) { healthFlow.first { it != null } }
            } catch (e: EngineError) {
                // The one connected before carries on; the one picked says it did not answer.
                failedFlow.value = Failed(place, e.message ?: "It did not answer", member)
                toast(e.message ?: "Could not switch")
                statusNow()
            }
            if (wanted) phaseFlow.value = Phase.On
        }
    }

    /** Off: the VPN first (apps go out the normal way, or the firewall alone keeps running), then
     *  the relay, so no app is ever pointed at a relay that stopped. */
    fun disconnect() {
        connecting?.cancel()
        wanted = false
        fallenBackFlow.value = false
        Settings.connectedInBoot = -1
        phaseFlow.value = Phase.Off
        healthFlow.value = null
        ticker?.cancel()
        scope.launch {
            Vpn.apply(app)
            try {
                statusFlow.value = Status.of(Engine.obj("disconnect"))
            } catch (e: EngineError) {
                statusFlow.value = Status.OFF
            }
            ratesFlow.value = Rates()
            refreshOwnIp()
        }
    }

    fun toggle(place: PlaceRef?) {
        if (wanted) disconnect() else if (place != null) connect(place)
    }

    /** A probe right now ("Check again"). */
    suspend fun testNow() {
        try {
            val s = Status.of(Engine.obj("testNow"))
            statusFlow.value = s
            s.health?.let { healthFlow.value = it }
        } catch (e: EngineError) {
            toast(e.message ?: "Could not check")
        }
    }

    /** For Firewall.plan: a proxy is connected and the phone goes through it. */
    fun throughProxy(): Boolean = wanted && statusFlow.value.running && !fallenBackFlow.value

    fun setNet(n: Net) {
        if (netFlow.value != n) {
            netFlow.value = n
            Vpn.applyQuietly(app)
        }
    }

    suspend fun refreshOwnIp() {
        try {
            val o = Engine.call("ownIp") as? JSONObject ?: return
            ownIpFlow.value = OwnIp(o.optString("ip"), o.str("countryCode")?.lowercase(), o.str("city"), o.str("timezone"))
        } catch (e: EngineError) {
            // Offline: the screen says "Your own IP" without one.
        }
    }

    private fun startTicker() {
        ticker?.cancel()
        ticker = scope.launch {
            var last = statusFlow.value.stats
            var lastAt = System.currentTimeMillis()
            while (isActive && wanted) {
                delay(1000)
                val s = statusNow()
                val now = System.currentTimeMillis()
                val secs = ((now - lastAt).coerceAtLeast(1)) / 1000.0
                ratesFlow.value = Rates(
                    down = ((s.stats.bytesDown - last.bytesDown).coerceAtLeast(0) / secs).toLong(),
                    up = ((s.stats.bytesUp - last.bytesUp).coerceAtLeast(0) / secs).toLong(),
                )
                last = s.stats
                lastAt = now
            }
        }
    }

    // ---------------------------------------------------------------------------------------
    // What the engine says on its own
    // ---------------------------------------------------------------------------------------

    private suspend fun onEvent(e: JSONObject) {
        when (e.optString("type")) {
            "health" -> {
                val h = Health.of(e) ?: return
                healthFlow.value = h
                statusFlow.value = statusFlow.value.copy(health = h)
                val place = statusFlow.value.place
                if (h.ok && place != null && h.latitude != null && h.longitude != null && !(kotlin.math.abs(h.latitude) < 0.01 && kotlin.math.abs(h.longitude) < 0.01)) {
                    Settings.rememberExit(place.key, Exit(h.latitude, h.longitude, h.city, h.countryCode))
                }
                followDrops(h)
                com.hproxy.app.vpn.HProxyVpnService.running?.refresh()
            }
            "connection" -> {
                statusNow()
                com.hproxy.app.vpn.HProxyVpnService.running?.refresh()
            }
            "tunnel" -> if (!e.optBoolean("up", true)) Vpn.ended(app, e.optString("why"))
            "blocked" -> Blocked.tried(app, e)
            "check", "checkGeo", "checkDone" -> {
                CheckerState.onEvent(e)
                JustAdded.onEvent(e)
            }
            "chat" -> SupportChat.onEvent(e)
        }
    }

    /** "If it drops: use your own internet": out of the VPN after two probes in a row failed,
     *  back in the moment one answers. "Block the internet" (the default) keeps the VPN: apps get
     *  nothing until the proxy answers, never the phone's own address. */
    private fun followDrops(h: Health) {
        if (!wanted || Settings.prefs.value.blockWhenDown) {
            if (fallenBackFlow.value) {
                fallenBackFlow.value = false
                Vpn.applyQuietly(app)
            }
            return
        }
        if (!h.ok && h.failuresInARow >= 2 && !fallenBackFlow.value) {
            fallenBackFlow.value = true
            Vpn.applyQuietly(app)
        } else if (h.ok && fallenBackFlow.value) {
            fallenBackFlow.value = false
            Vpn.applyQuietly(app)
        }
    }

    /** Firewall rules or settings changed: the VPN follows. */
    fun rulesChanged() {
        Vpn.applyQuietly(app)
        Blocked.forgetAllowed(app)
    }

    /** The plan for the VPN as things stand. */
    fun plan(): Firewall.Plan = Firewall.plan(
        app,
        connected = throughProxy(),
        net = netFlow.value,
        prefs = Settings.prefs.value,
        rules = Settings.rules.value,
        known = Settings.knownApps,
    )

    /** The VPN ended without being asked (another VPN app took over, or the phone's settings). */
    fun vpnRevoked() {
        // Off for good, also after an update: HProxy never takes the VPN back from where it went.
        Settings.connectedInBoot = -1
        if (wanted) {
            wanted = false
            phaseFlow.value = Phase.Off
            ticker?.cancel()
            scope.launch {
                try {
                    statusFlow.value = Status.of(Engine.obj("disconnect"))
                } catch (e: EngineError) {
                    statusFlow.value = Status.OFF
                }
                toast("Another VPN took over, so HProxy disconnected.")
            }
        }
    }
}
