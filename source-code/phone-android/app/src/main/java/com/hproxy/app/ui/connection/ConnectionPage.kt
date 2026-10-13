package com.hproxy.app.ui.connection

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.PlaceRef
import com.hproxy.app.state.AppState
import com.hproxy.app.state.CheckerId
import com.hproxy.app.state.FraudScores
import com.hproxy.app.state.FreeList
import com.hproxy.app.state.Phase
import com.hproxy.app.state.Settings
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.Page
import com.hproxy.app.ui.Tab
import com.hproxy.app.ui.home.masked
import com.hproxy.app.ui.home.whereOf
import com.hproxy.app.ui.kit.Btn
import com.hproxy.app.ui.kit.BtnKind
import com.hproxy.app.ui.kit.Flag
import com.hproxy.app.ui.kit.Glyph
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.IconBtn
import com.hproxy.app.ui.kit.Line
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.copy
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.proxies.Fact
import com.hproxy.app.ui.proxies.FactText
import com.hproxy.app.ui.proxies.ScoreFact
import com.hproxy.app.ui.proxies.scoreFor
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

fun clock(secs: Long): String {
    val m = secs / 60
    val s = secs % 60
    val h = m / 60
    return if (h > 0) "%d:%02d:%02d".format(h, m % 60, s) else "%d:%02d".format(m, s)
}

/** "2.4 MB/s", "310 KB/s". */
private fun rate(bytesPerSec: Long): String = when {
    bytesPerSec >= 1_000_000 -> "%.1f MB/s".format(bytesPerSec / 1_000_000.0)
    else -> "${bytesPerSec / 1000} KB/s"
}

/**
 * The connection in detail, opened from Home's card (the big VPN apps' connection details: your
 * address and the one you appear with, the speed as it goes, how long, where, which server). Ours
 * adds the proxy itself, what it is, every fraud checker's score, and the tools for a connection:
 * what sites see, a speed test, which apps go through it, its login and formats, what happens if it
 * stops. Back is the arrow, the word beside it, or the phone's own back.
 */
@Composable
fun ConnectionPage(nav: Nav, onBack: () -> Unit) {
    val conn by AppState.conn.collectAsState()
    val health by AppState.health.collectAsState()
    val own by AppState.ownIp.collectAsState()
    val rates by AppState.rates.collectAsState()
    val prefs by Settings.prefs.collectAsState()
    val rules by Settings.rules.collectAsState()
    val checkers by Settings.checkers.collectAsState()
    val scores by FraudScores.scores.collectAsState()
    @Suppress("UNUSED_VARIABLE") val read = Triple(AppState.library.collectAsState().value, FreeList.list.collectAsState().value, Settings.freeNames.collectAsState().value)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val ref = AppState.switchTarget()
    val where = whereOf(ref, conn, health)
    val on = conn.phase == Phase.On && conn.running
    val busy = conn.phase is Phase.Connecting || conn.phase is Phase.Switching
    val exitIp = health?.exitIp?.takeIf { on && health?.ok == true }
    val freeExit = (ref as? PlaceRef.Free)?.exit?.let(FreeList::find)
    val saved = (ref as? PlaceRef.Proxy)?.let { r -> AppState.library.value.proxies.find { it.id == r.id } }
    val address = freeExit?.addr ?: (ref as? PlaceRef.Free)?.exit ?: saved?.address ?: AppState.status.value.freeExit
    val scoreIp = exitIp ?: freeExit?.host ?: saved?.last?.exitIp
    val answering = CheckerId.entries.filter { checkers[it]?.answers(it) == true }
    LaunchedEffect(scoreIp, answering) {
        val ip = scoreIp ?: return@LaunchedEffect
        for (id in answering) FraudScores.want(id, listOf(ip))
    }

    // The last minute of speed, a point a second.
    val history = remember { mutableStateListOf<Pair<Long, Long>>() }
    LaunchedEffect(rates, on) {
        if (!on) return@LaunchedEffect
        history.add(rates.down to rates.up)
        while (history.size > 60) history.removeAt(0)
    }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(on) {
        while (on) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    var speedTest by remember { mutableStateOf<String?>(null) }
    var measuring by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().background(C.bg)) {
        // Back: the arrow and the word, one wide target.
        Row(
            Modifier
                .statusBarsPadding()
                .padding(start = 6.dp, top = 6.dp)
                .height(52.dp)
                .pressable(onBack, scale = 0.97f)
                .padding(end = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconBtn(I.left, onBack, size = 48.dp, glyph = 26.dp, description = "Back")
            Txt("Home", type(16.sp, FontWeight.Bold, C.ink2))
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(top = 4.dp)) {
                if (where?.cc != null) Flag(where.cc, 40.dp, 30.dp)
                Column {
                    Txt(where?.country ?: "Not connected", type(26.sp, FontWeight.Bold, spacing = (-0.02).em), maxLines = 1)
                    Txt(listOfNotNull(where?.city, where?.proxy).joinToString(" · "), type(14.5.sp, FontWeight.SemiBold, C.ink2, numbers = true), maxLines = 1)
                }
            }
            Spacer(Modifier.height(16.dp))
            // Your IP → the proxy's IP.
            val shape = cut(18.dp, 6.dp)
            Row(
                Modifier.fillMaxWidth().clip(shape).background(C.s1).border(1.dp, C.line, shape).padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Txt("Your IP", type(12.5.sp, FontWeight.SemiBold, C.ink3))
                    Spacer(Modifier.height(3.dp))
                    Txt(masked(own?.ip) ?: "Not known", type(15.5.sp, FontWeight.Bold, numbers = true), maxLines = 1)
                }
                Ic(I.across, 20.dp, C.ink3)
                Column(Modifier.weight(1f), horizontalAlignment = Alignment.End) {
                    Txt("Proxy IP", type(12.5.sp, FontWeight.SemiBold, C.ink3))
                    Spacer(Modifier.height(3.dp))
                    Txt(
                        exitIp ?: if (busy) "Connecting" else "Not connected",
                        type(15.5.sp, FontWeight.Bold, if (exitIp != null) C.blueInk else C.ink2, numbers = true),
                        maxLines = 1,
                    )
                }
            }
            if (on) {
                Head("Speed")
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    SpeedNumber(I.arrowDown, "Download", rate(rates.down), C.blueInk, Modifier.weight(1f))
                    SpeedNumber(I.arrowUp, "Upload", rate(rates.up), C.warn, Modifier.weight(1f))
                }
                Spacer(Modifier.height(10.dp))
                SpeedChart(history, Modifier.fillMaxWidth().height(110.dp))
            }
            Head("Connection details")
            Line()
            if (on) Fact("Connected for") { FactText(clock(((now - (conn.since ?: now)) / 1000).coerceAtLeast(0))) }
            Fact("Location") { FactText(listOfNotNull(where?.city, where?.country).joinToString(", ").ifEmpty { "Not known" }) }
            if (address != null) {
                Fact("Proxy") {
                    FactText(address)
                    IconBtn(I.copy, {
                        copy(context, address)
                        AppState.toast("$address copied")
                    }, size = 30.dp, glyph = 18.dp, description = "Copy the proxy", tint = C.ink2)
                }
            }
            (freeExit?.proto ?: saved?.scheme?.uppercase())?.let { Fact("Protocol") { FactText(it) } }
            health?.latencyMs?.takeIf { on }?.let { ms -> Fact("Response") { FactText("$ms ms") } }
            if (scoreIp != null) for (id in answering) ScoreFact(if (answering.size == 1) "Fraud score" else id.label, scoreFor(scores, id, scoreIp))

            Head("Tools")
            Tool(I.shield, "What sites see", "IP and leaks") { nav.push(Page.Checks) }
            Tool(I.bolt, "Speed test", speedTest ?: if (measuring) "Measuring" else if (on) "About 3 MB" else "Once connected") {
                if (measuring || !on) return@Tool
                measuring = true
                scope.launch {
                    speedTest = try {
                        "%.1f Mbit/s".format(Engine.obj("speed").optDouble("mbps"))
                    } catch (e: EngineError) {
                        AppState.toast(e.message ?: "The speed test did not finish")
                        null
                    }
                    measuring = false
                }
            }
            val special = if (prefs.allThroughProxy) rules.values.count { it.proxy == false } else rules.values.count { it.proxy == true }
            Tool(I.apps, "Apps that use the proxy", when {
                prefs.allThroughProxy && special == 0 -> "All apps"
                prefs.allThroughProxy -> "All but $special"
                else -> if (special == 1) "1 app" else "$special apps"
            }) { nav.push(Page.Apps) }
            if (saved != null) Tool(I.info, "Login and formats", "Every way to write it") { nav.push(Page.Details) }
            Tool(I.lock, "If the proxy stops", if (prefs.blockWhenDown) "Block the internet" else "Use your own") {
                Settings.update { it.copy(blockWhenDown = !it.blockWhenDown) }
                AppState.rulesChanged()
            }
        }
        // The one button, as on Home.
        Box(Modifier.fillMaxWidth().background(C.bg).navigationBarsPadding().padding(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 14.dp)) {
            when {
                busy -> Btn("Cancel", { AppState.disconnect() }, Modifier.fillMaxWidth(), kind = BtnKind.Raised)
                on -> Btn("Disconnect", { AppState.disconnect() }, Modifier.fillMaxWidth(), kind = BtnKind.Raised)
                ref != null -> Btn("Connect", { nav.askVpn { AppState.connect(ref) } }, Modifier.fillMaxWidth())
                else -> Btn("Pick a proxy", {
                    onBack()
                    nav.go(Tab.Proxies)
                }, Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun Head(text: String) {
    Txt(text, type(13.sp, FontWeight.Bold, C.ink3), modifier = Modifier.padding(top = 20.dp, bottom = 8.dp))
}

@Composable
private fun SpeedNumber(g: Glyph, label: String, value: String, ink: Color, modifier: Modifier) {
    Column(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Ic(g, 15.dp, ink)
            Txt(label, type(12.5.sp, FontWeight.SemiBold, C.ink3))
        }
        Spacer(Modifier.height(3.dp))
        Txt(value, type(18.sp, FontWeight.Bold, numbers = true))
    }
}

/** The last minute of speed: download in blue, upload in amber, lines only. */
@Composable
private fun SpeedChart(points: List<Pair<Long, Long>>, modifier: Modifier) {
    val shape = cut(16.dp, 6.dp)
    Box(modifier.clip(shape).background(C.s1).border(1.dp, C.line, shape).padding(12.dp)) {
        Canvas(Modifier.fillMaxSize()) {
            // Three hairlines across, for the eye.
            for (k in 1..3) {
                val y = size.height * k / 4f
                drawLine(C.line, Offset(0f, y), Offset(size.width, y), strokeWidth = 1f)
            }
            if (points.size < 2) return@Canvas
            val top = points.maxOf { maxOf(it.first, it.second) }.coerceAtLeast(1L).toFloat()
            fun line(pick: (Pair<Long, Long>) -> Long, color: Color) {
                val path = Path()
                points.forEachIndexed { i, p ->
                    val x = size.width * i / 59f
                    val y = size.height - size.height * (pick(p) / top) * 0.92f
                    if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                drawPath(path, color, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
            line({ it.second }, C.warn)
            line({ it.first }, C.blueInk)
        }
    }
}

/** A tool of the connection: its glyph alone, its words, what it says now. */
@Composable
private fun Tool(g: Glyph, title: String, value: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 58.dp).pressable(onClick, scale = 0.985f),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.width(26.dp), contentAlignment = Alignment.Center) { Ic(g, 22.dp, C.ink2) }
        Txt(title, type(15.5.sp, FontWeight.SemiBold), modifier = Modifier.weight(1f), maxLines = 1)
        Txt(value, type(14.sp, FontWeight.SemiBold, C.ink2, numbers = true), maxLines = 1)
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) { Ic(I.right, 18.dp, C.ink3) }
    }
}
