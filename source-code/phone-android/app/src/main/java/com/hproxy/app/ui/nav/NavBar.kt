package com.hproxy.app.ui.nav

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hproxy.app.state.AppState
import com.hproxy.app.state.FreeList
import com.hproxy.app.state.Phase
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.Tab
import com.hproxy.app.ui.kit.Glyph
import com.hproxy.app.ui.kit.HMark
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.Glide
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type

/** Five places in the tab row: two tabs, the H button, two tabs. */
private val SLOTS = listOf(Tab.Home, Tab.Proxies, null, Tab.Checker, Tab.Help)

/** How far the H button stands above the bar. */
private val RAISE = 20.dp

/**
 * The nav at the bottom, shaped like the big VPN apps' (a few tabs and one large
 * button in the middle that connects). Its middle is the H button: pressing it always takes you to
 * Home, the connection full screen, and connects there or disconnects (2026-10-12). It stands
 * above the bar so either thumb finds it; it is blue to connect, a line runs round it while it
 * connects, and it is white with a blue H once on.
 */
@Composable
fun NavBar(nav: Nav, modifier: Modifier = Modifier) {
    val conn by AppState.conn.collectAsState()
    // Read so the button knows what it connects once the free list is in (AppState.switchTarget).
    @Suppress("UNUSED_VARIABLE") val read = Pair(AppState.library.collectAsState().value, FreeList.list.collectAsState().value)
    val phase = conn.phase
    val switching = phase is Phase.Switching
    val on = phase == Phase.On || switching
    val busy = phase is Phase.Connecting
    val stopped = phase == Phase.On && conn.stopped

    val press: () -> Unit = {
        nav.go(Tab.Home)
        if (on || busy) {
            AppState.disconnect()
        } else {
            val target = AppState.switchTarget()
            if (target != null) nav.askVpn { AppState.connect(target) } else nav.go(Tab.Proxies)
        }
    }

    Box(modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(top = RAISE)) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(C.line))
            Column(Modifier.fillMaxWidth().background(C.s1).navigationBarsPadding()) {
                Tabs(
                    nav.tab,
                    word = when {
                        stopped -> "Not answering"
                        switching -> "Switching"
                        busy -> "Connecting"
                        on -> "Connected"
                        else -> "Connect"
                    },
                    wordInk = when {
                        stopped -> C.bad
                        on || busy -> C.blueInk
                        else -> C.ink2
                    },
                    onTab = { nav.go(it) },
                )
            }
        }
        HButton(on = on, busy = busy || switching, stopped = stopped, onClick = press, modifier = Modifier.align(Alignment.TopCenter))
    }
}

@Composable
private fun Tabs(tab: Tab, word: String, wordInk: Color, onTab: (Tab) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 6.dp)) {
        val slot = maxWidth / SLOTS.size
        val at by animateDpAsState(slot * SLOTS.indexOf(tab) + (slot - 30.dp) / 2, tween(420, easing = Glide), label = "crossbar")
        // The H's crossbar marks the tab you are on, at the top edge of the row.
        Box(
            Modifier
                .offset { IntOffset(at.roundToPx(), 0) }
                .size(30.dp, 3.dp)
                .clip(RoundedCornerShape(bottomStart = 3.dp, bottomEnd = 3.dp))
                .background(C.blue),
        )
        Row(Modifier.fillMaxSize()) {
            for (t in SLOTS) {
                if (t == null) {
                    // The H button stands above this slot; its word sits on the row like every tab's.
                    Column(Modifier.weight(1f).fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                        Spacer(Modifier.height(37.dp))
                        val ink by animateColorAsState(wordInk, tween(300), label = "hWordInk")
                        AnimatedContent(
                            word,
                            transitionSpec = {
                                slideInVertically(tween(380, easing = Glide)) { it } togetherWith slideOutVertically(tween(240, easing = Glide)) { -it }
                            },
                            modifier = Modifier.clipToBounds(),
                            label = "hWord",
                        ) { w -> Txt(w, type(12.sp, FontWeight.Bold), color = ink, maxLines = 1) }
                    }
                } else {
                    TabSlot(t, t == tab, Modifier.weight(1f)) { onTab(t) }
                }
            }
        }
    }
}

private fun glyphOf(t: Tab): Glyph = when (t) {
    Tab.Home -> I.home
    Tab.Proxies -> I.places
    Tab.Checker -> I.checker
    Tab.Help -> I.chat
}

private fun labelOf(t: Tab): String = when (t) {
    Tab.Home -> "Home"
    Tab.Proxies -> "Proxies"
    Tab.Checker -> "Checker"
    Tab.Help -> "Help"
}

@Composable
private fun TabSlot(t: Tab, chosen: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val glyph by animateColorAsState(if (chosen) C.blueInk else C.ink3, tween(220), label = "tabGlyph")
    val word by animateColorAsState(if (chosen) C.ink else C.ink3, tween(220), label = "tabWord")
    Column(
        modifier
            .fillMaxSize()
            .pressable(onClick, scale = 0.94f)
            .semantics { role = Role.Tab },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.height(34.dp), contentAlignment = Alignment.Center) { Ic(glyphOf(t), 23.dp, glyph) }
        Spacer(Modifier.height(3.dp))
        Txt(labelOf(t), type(12.sp, FontWeight.Bold), color = word, maxLines = 1)
    }
}

/**
 * The H button: cut like the H (round top-left and bottom-right), on a ring of the page's own
 * colour that cuts it out of the bar. Blue with a white H: connect. A line runs round it while
 * connecting. White with a blue H: on (a red H when the proxy stopped answering).
 */
@Composable
private fun HButton(on: Boolean, busy: Boolean, stopped: Boolean, onClick: () -> Unit, modifier: Modifier) {
    val lit = on && !busy
    val bg by animateColorAsState(if (lit) C.white else C.blue, tween(380), label = "hBg")
    val ink by animateColorAsState(
        when {
            stopped -> C.bad
            lit -> C.blue
            else -> C.white
        },
        tween(380),
        label = "hInk",
    )
    val shape = cut(24.dp, 9.dp)
    Box(
        modifier
            .size(68.dp)
            .pressable(onClick, scale = 0.92f)
            .semantics {
                role = Role.Button
                contentDescription = if (on || busy) "Disconnect" else "Connect"
            },
        contentAlignment = Alignment.Center,
    ) {
        // The ring that cuts the button out of the bar: solid, the page's colour.
        Box(Modifier.size(68.dp).clip(cut(27.dp, 10.dp)).background(C.bg))
        Box(Modifier.size(58.dp).clip(shape).background(bg).border(1.dp, if (lit) C.white else C.blue, shape), contentAlignment = Alignment.Center) {
            HMark(24.dp, ink)
        }
        if (busy) Turning(Modifier.size(68.dp))
    }
}

/** A short arc running round the button while it connects: a line, never a wash of colour. */
@Composable
private fun Turning(modifier: Modifier) {
    val t = rememberInfiniteTransition(label = "turning")
    val angle by t.animateFloat(0f, 360f, infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Restart), label = "angle")
    Canvas(modifier.graphicsLayer { rotationZ = angle }) {
        val inset = 2.dp.toPx()
        drawArc(
            color = C.blueInk,
            startAngle = -90f,
            sweepAngle = 110f,
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = Size(size.width - inset * 2, size.height - inset * 2),
            style = Stroke(width = 2.5.dp.toPx(), cap = StrokeCap.Square),
        )
    }
}
