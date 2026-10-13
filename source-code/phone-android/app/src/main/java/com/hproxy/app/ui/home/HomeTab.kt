package com.hproxy.app.ui.home

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.engine.Health
import com.hproxy.app.engine.PlaceRef
import com.hproxy.app.engine.countryName
import com.hproxy.app.engine.spelled
import com.hproxy.app.state.AppState
import com.hproxy.app.state.Conn
import com.hproxy.app.state.FreeList
import com.hproxy.app.state.OwnIp
import com.hproxy.app.state.Phase
import com.hproxy.app.state.Settings
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.Page
import com.hproxy.app.ui.kit.Btn
import com.hproxy.app.ui.kit.BtnKind
import com.hproxy.app.ui.kit.Flag
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.map.ConnectionMap
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.Glide
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type

/** Where a place is, in words: its flag, its country, its city, and the proxy itself (its name or
 *  its address). Once a probe through it answered, the probe says where it comes out. */
internal data class Where(val cc: String?, val country: String, val city: String?, val proxy: String)

internal fun whereOf(ref: PlaceRef?, conn: Conn, health: Health?): Where? {
    ref ?: return null
    val shown = AppState.show(ref) ?: return null
    val lib = AppState.library.value
    var cc = shown.cc
    var city: String? = null
    when (ref) {
        is PlaceRef.Free -> {
            val e = ref.exit?.let(FreeList::find)
            cc = e?.cc ?: cc
            city = e?.city
        }
        is PlaceRef.Proxy -> {
            val p = lib.proxies.find { it.id == ref.id }
            city = listOfNotNull(p?.about?.city, p?.about?.region).firstOrNull()?.let(::spelled) ?: p?.last?.place?.substringBefore(',')
        }
        is PlaceRef.Group -> {
            val g = lib.groups.find { it.id == ref.id }
            city = listOfNotNull(g?.shared?.city, g?.shared?.region).firstOrNull()?.let(::spelled)
        }
    }
    val probe = health?.takeIf { it.ok && conn.running && conn.place == ref.key }
    if (probe != null) {
        cc = probe.countryCode ?: cc
        city = probe.city ?: city
    }
    val country = probe?.country ?: countryName(cc) ?: "Somewhere"
    return Where(cc, country, city?.takeIf { it.isNotBlank() }, shown.name)
}

/** "84.17.••.•••": the phone's own address, half hidden. */
internal fun masked(ip: String?): String? {
    if (ip == null) return null
    val parts = ip.split('.')
    if (parts.size == 4) return "${parts[0]}.${parts[1]}.••.•••"
    return ip.split(':').filter { it.isNotEmpty() }.take(2).joinToString(":") + ":••••:••••"
}

/**
 * Home: the connection itself, full screen, shaped like the big VPN apps' home (the
 * state and your address on top, the map, the place you connect to in a card with one button, your
 * recent places under it), in HProxy's own look: the dot map that dives to the city and turns
 * blue, the H's cut, solid colours. The card shows the country and the city above the proxy itself
 * (2026-10-12);
 * pressing it opens everything about the connection.
 */
@Composable
fun HomeTab(nav: Nav) {
    val conn by AppState.conn.collectAsState()
    val health by AppState.health.collectAsState()
    val own by AppState.ownIp.collectAsState()
    // Read so Home draws again when the place it shows can change.
    @Suppress("UNUSED_VARIABLE") val read = Triple(
        AppState.library.collectAsState().value,
        FreeList.list.collectAsState().value,
        Settings.freeNames.collectAsState().value,
    )
    LaunchedEffect(Unit) { FreeList.load() }

    val ref = AppState.switchTarget()
    val where = whereOf(ref, conn, health)
    val phase = conn.phase
    val switching = phase is Phase.Switching
    val on = phase == Phase.On || switching
    val busy = phase is Phase.Connecting
    val stopped = phase == Phase.On && conn.stopped
    val failed = !on && !busy && conn.failed != null && conn.failed?.ref?.key == ref?.key

    Box(Modifier.fillMaxSize().background(C.bg)) {
        Column(Modifier.fillMaxSize()) {
            // The map, with the state over it.
            BoxWithConstraints(Modifier.fillMaxWidth().weight(1f).heightIn(min = 220.dp).clipToBounds()) {
                val w = maxWidth.value.toDouble()
                val h = maxHeight.value.toDouble()
                ConnectionMap(w, h, w / 2, (h * 0.62).coerceAtLeast(190.0), floodFrom = null)
                Status(phase, on, busy, stopped, failed, conn, health, own, where, Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 14.dp))
                // Settings, a gear at the top right (the tabs are for what is used every day).
                com.hproxy.app.ui.kit.IconBtn(
                    I.rule,
                    { nav.push(Page.Settings) },
                    Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(end = 8.dp, top = 6.dp),
                    description = "Settings",
                    tint = if (on) C.white else C.ink2,
                )
            }
            // The place, its one button, and the recent ones.
            Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 8.dp)) {
                Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Txt(
                        when {
                            busy -> "Connecting to"
                            switching -> "Switching to"
                            on -> "Connected to"
                            failed -> "Didn't answer"
                            AppState.target() == null -> "Fastest free proxy"
                            else -> "Last used"
                        },
                        type(13.sp, FontWeight.SemiBold, if (failed) C.bad else C.ink2),
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                    )
                    Row(
                        Modifier.pressable({ nav.go(com.hproxy.app.ui.Tab.Help) }, scale = 0.95f).padding(start = 12.dp, top = 4.dp, bottom = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Txt("Help", type(13.sp, FontWeight.SemiBold, C.ink2))
                        Ic(I.help, 17.dp, C.ink2)
                    }
                }
                PlaceCard(
                    where = where,
                    on = on,
                    busy = busy || switching,
                    failed = failed,
                    onOpen = { nav.push(Page.Connection) },
                    onConnect = {
                        if (ref == null) nav.go(com.hproxy.app.ui.Tab.Proxies) else nav.askVpn { AppState.connect(ref) }
                    },
                    onDisconnect = { AppState.disconnect() },
                )

            }
        }
    }
}

/** The state, centred over the map: a lock, the words, and where you appear. */
@Composable
private fun Status(
    phase: Phase,
    on: Boolean,
    busy: Boolean,
    stopped: Boolean,
    failed: Boolean,
    conn: Conn,
    health: Health?,
    own: OwnIp?,
    where: Where?,
    modifier: Modifier,
) {
    val headline = when {
        stopped -> "Not answering"
        phase is Phase.Switching -> "Switching"
        busy -> "Connecting"
        on -> "Connected"
        failed -> "Didn't answer"
        else -> "You're not connected"
    }
    val ink = if (stopped || failed) C.bad else C.white
    Column(modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
            when {
                busy || phase is Phase.Switching -> Spinner(26.dp, C.white)
                on && !stopped -> Ic(I.lock, 26.dp, C.white)
                else -> Ic(I.unlock, 26.dp, if (stopped || failed) C.bad else C.ink2)
            }
        }
        Spacer(Modifier.height(8.dp))
        // A new state rises in from behind its own foot: it moves, it never fades.
        AnimatedContent(
            headline,
            transitionSpec = { slideInVertically(tween(420, easing = Glide)) { it } togetherWith slideOutVertically(tween(260, easing = Glide)) { -it } },
            modifier = Modifier.clipToBounds(),
            label = "headline",
        ) { h -> Txt(h, type(22.sp, FontWeight.Bold, spacing = (-0.015).em), color = ink, maxLines = 1) }
        Spacer(Modifier.height(10.dp))
        val ip = health?.exitIp
        when {
            on && !stopped && health?.ok == true && ip != null -> Chip(health.countryCode ?: where?.cc, "${health.country ?: where?.country ?: "Here"} · $ip", light = true)
            on && stopped -> Chip(null, "The proxy stopped answering", light = true)
            on -> Chip(null, "Checking where you appear", light = true)
            busy -> Chip(null, if ((phase as? Phase.Connecting)?.step == 1) "Checking where you appear" else "Reaching the proxy", light = false)
            own != null -> Chip(own.cc, listOfNotNull(countryName(own.cc), masked(own.ip)).joinToString(" · ").ifEmpty { "Your own IP" }, light = false)
            else -> Chip(null, "Your own IP", light = false)
        }
    }
}

/** A short line of where you appear, on its own solid ground: white over the blue, dark over the map. */
@Composable
private fun Chip(cc: String?, text: String, light: Boolean) {
    val shape = cut(12.dp, 4.dp)
    Row(
        Modifier
            .height(32.dp)
            .clip(shape)
            .background(if (light) C.white else C.s2)
            .border(1.dp, if (light) C.white else C.line, shape)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (cc != null) Flag(cc, 18.dp, 13.dp, line = false)
        Txt(text, type(13.5.sp, FontWeight.SemiBold, if (light) C.nearBlack else C.ink, numbers = true), maxLines = 1)
    }
}

/** The place you connect to: its flag, its country, its city and the proxy itself; one button. */
@Composable
private fun PlaceCard(
    where: Where?,
    on: Boolean,
    busy: Boolean,
    failed: Boolean,
    onOpen: () -> Unit,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
) {
    val shape = cut(22.dp, 8.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(C.s1)
            .border(1.dp, C.line, shape)
            .padding(14.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().pressable(onOpen, scale = 0.985f).padding(start = 2.dp, end = 2.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (where?.cc != null) Flag(where.cc, 36.dp, 27.dp) else Box(Modifier.size(36.dp, 27.dp), contentAlignment = Alignment.Center) { Ic(I.globe, 24.dp, C.ink3) }
            Column(Modifier.weight(1f)) {
                Txt(where?.country ?: "Pick a proxy", type(18.sp, FontWeight.Bold, spacing = (-0.01).em), maxLines = 1)
                Spacer(Modifier.height(2.dp))
                Txt(
                    where?.let { listOfNotNull(it.city, it.proxy).joinToString(" · ") } ?: "Your own, or a free one",
                    type(13.5.sp, FontWeight.Medium, C.ink2, numbers = true),
                    maxLines = 1,
                )
            }
            Ic(I.right, 22.dp, C.ink3)
        }
        when {
            busy -> Btn("Cancel", onDisconnect, Modifier.fillMaxWidth(), kind = BtnKind.Raised)
            on -> Btn("Disconnect", onDisconnect, Modifier.fillMaxWidth(), kind = BtnKind.Raised)
            failed -> Btn("Try again", onConnect, Modifier.fillMaxWidth())
            else -> Btn("Connect", onConnect, Modifier.fillMaxWidth())
        }
    }
}

/** A short arc that turns: connecting. */
@Composable
internal fun Spinner(size: androidx.compose.ui.unit.Dp, color: Color) {
    val t = rememberInfiniteTransition(label = "spin")
    val angle by t.animateFloat(0f, 360f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "angle")
    Canvas(Modifier.size(size).graphicsLayer { rotationZ = angle }) {
        val inset = 2.dp.toPx()
        drawArc(
            color = color,
            startAngle = -90f,
            sweepAngle = 100f,
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = Size(this.size.width - inset * 2, this.size.height - inset * 2),
            style = Stroke(width = 2.5.dp.toPx(), cap = StrokeCap.Square),
        )
    }
}
