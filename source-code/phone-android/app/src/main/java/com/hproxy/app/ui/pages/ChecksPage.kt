package com.hproxy.app.ui.pages

import android.content.Intent
import android.provider.Settings as AndroidSettings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.Kind
import com.hproxy.app.engine.Shown
import com.hproxy.app.engine.countryName
import com.hproxy.app.engine.map
import com.hproxy.app.engine.str
import com.hproxy.app.state.AppState
import com.hproxy.app.state.Settings
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.kit.Glyph
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.PushHead
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.Flag
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.Spring
import com.hproxy.app.ui.theme.T
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type
import java.util.TimeZone
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class Mark { Wait, Run, Pass, Warn, None }

private data class Found(val mark: Mark, val value: String, val note: String, val fix: Boolean = false)

/**
 * What sites see (from the design's checks): four checks that run in front of you, one card after the
 * other. Every new IP runs them again, because a new exit is a new answer.
 *
 *   Your IP    the address sites see, from our judge, never the phone's own
 *   DNS        which resolver the proxy looks names up with (our leak test, through it)
 *   WebRTC     no phone address escapes: the tunnel carries no UDP around the proxy
 *   Time zone  the phone's clock zone against the exit's; a mismatch is a warning with a way to
 *              fix it, never a silent pass
 */
@Composable
fun ChecksPage(nav: Nav, onBack: () -> Unit) {
    val library by AppState.library.collectAsState()
    val status by AppState.status.collectAsState()
    val health by AppState.health.collectAsState()
    val own by AppState.ownIp.collectAsState()
    val prefs by Settings.prefs.collectAsState()
    val rules by Settings.rules.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var round by remember { mutableIntStateOf(0) }
    var dns by remember { mutableStateOf<Found?>(null) }
    var landed by remember { mutableIntStateOf(0) }
    val shown = com.hproxy.app.state.AppState.show(status.place ?: com.hproxy.app.state.AppState.target())

    LaunchedEffect(health?.exitIp, round) {
        landed = 0
        dns = null
        if (!status.running) return@LaunchedEffect
        scope.launch {
            dns = try {
                val o = Engine.obj("dnsLeak")
                when (o.optString("state")) {
                    "seen" -> {
                        val resolvers = (o.optJSONArray("resolvers") ?: org.json.JSONArray()).map { it }
                        val cc = resolvers.firstNotNullOfOrNull { it.str("country_code") }?.lowercase()
                        val where = resolvers.firstNotNullOfOrNull { it.str("city") } ?: countryName(cc)
                        val exitCc = health?.countryCode
                        if (cc != null && exitCc != null && cc != exitCc) Found(Mark.Warn, "In ${countryName(cc) ?: cc.uppercase()}", "Not where you appear")
                        else Found(Mark.Pass, "At the exit", where?.let { "Answered in $it" } ?: "Answered by the proxy")
                    }
                    "not_seen" -> Found(Mark.Pass, "At the exit", "The proxy looks names up itself")
                    else -> Found(Mark.None, "Not checked", "The leak test did not answer")
                }
            } catch (e: EngineError) {
                Found(Mark.None, "Not checked", e.message ?: "")
            }
        }
        for (i in 1..4) {
            delay(if (i == 1) 420 else 320)
            landed = i
        }
    }

    val h = health
    val ipFound = when {
        h == null -> null
        !h.ok -> Found(Mark.Warn, "No answer", "The proxy did not answer")
        h.exitIp != null && own?.ip != null && h.exitIp == own?.ip -> Found(Mark.Warn, h.exitIp, "That is your own address")
        else -> Found(Mark.Pass, h.exitIp ?: "Hidden", "The proxy's, not yours")
    }
    val directApps = if (prefs.allThroughProxy) rules.values.any { it.proxy == false } else true
    val webrtc = Found(Mark.Pass, "Hidden", if (directApps) "In the apps that go through it" else "No phone address")
    val phoneZone = TimeZone.getDefault().id
    val exitZone = h?.timezone
    val tz = when {
        exitZone == null -> Found(Mark.None, "Not known", "The exit did not say")
        sameZone(phoneZone, exitZone) -> Found(Mark.Pass, "${zoneCity(exitZone)} time", "Matches the exit")
        else -> Found(Mark.Warn, "${zoneCity(phoneZone)} time", "Your phone's zone", fix = true)
    }
    val cards = listOf(
        Triple(I.pin, "Your IP", ipFound),
        Triple(I.dns, "DNS", dns),
        Triple(I.camera, "WebRTC", webrtc),
        Triple(I.clock, "Time zone", tz),
    )
    val marks = cards.mapIndexed { i, (_, _, f) ->
        when {
            !status.running -> Mark.Wait
            i >= landed || f == null -> Mark.Run
            else -> f.mark
        }
    }
    val running = marks.any { it == Mark.Run }
    val warned = marks.any { it == Mark.Warn }
    val passed = marks.count { it == Mark.Pass }

    Column(Modifier.fillMaxSize().background(C.bg)) {
        PushHead(onBack)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 40.dp)) {
            Txt("What sites see", T.title)
            Spacer(Modifier.height(10.dp))
            if (shown != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Flag(shown.cc, 32.dp, 24.dp)
                    Txt(shown.name, type(15.sp, FontWeight.Bold), maxLines = 1)
                }
            }
            Spacer(Modifier.height(18.dp))
            if (!status.running) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(18.dp))
                        .border(1.dp, C.line, RoundedCornerShape(18.dp))
                        .padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Ic(I.shield, 20.dp, C.ink2)
                    Txt("Connect to see what sites see", type(14.5.sp, FontWeight.SemiBold, C.ink2))
                }
            } else {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Txt(if (running) "Checking" else if (warned) "One thing to fix" else "Nothing leaks", type(17.sp, FontWeight.Bold), modifier = Modifier.weight(1f))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (m in marks) {
                        Box(
                            Modifier.size(8.dp).clip(RoundedCornerShape(2.dp)).background(
                                when (m) {
                                    Mark.Pass -> C.ok
                                    Mark.Warn -> C.warn
                                    else -> C.s3
                                },
                            ),
                        )
                    }
                    Spacer(Modifier.size(6.dp))
                    Txt("$passed/4", type(13.sp, FontWeight.Bold, C.ink2, numbers = true))
                    Spacer(Modifier.size(4.dp))
                    Box(
                        Modifier.size(30.dp).pressable({
                            round++
                            scope.launch { AppState.testNow() }
                        }, scale = 0.94f).clip(cut(10.dp, 4.dp)).background(C.s1),
                        contentAlignment = Alignment.Center,
                    ) { Ic(I.again, 16.dp, C.ink2) }
                }
            }
            Spacer(Modifier.height(10.dp))
            for (row in 0..1) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (col in 0..1) {
                        val i = row * 2 + col
                        val (g, label, f) = cards[i]
                        Card(
                            g,
                            label,
                            marks[i],
                            f,
                            Modifier.weight(1f),
                            onFix = { context.startActivity(Intent(AndroidSettings.ACTION_DATE_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) },
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
            }
            if (tz.fix && marks[3] == Mark.Warn && exitZone != null) {
                Spacer(Modifier.height(6.dp))
                Txt(
                    "Sites can compare your phone's clock with where your address is. Set the zone to ${zoneCity(exitZone)} in the phone's settings (Fix) to match.",
                    type(13.5.sp, FontWeight.SemiBold, C.ink3, lineHeight = 19.sp),
                )
            }
            }
        }
    }
}

private fun zoneCity(tz: String) = tz.substringAfterLast('/').replace('_', ' ')

/** Two zones are the same when their clocks say the same now (Berlin and Paris are). */
private fun sameZone(a: String, b: String): Boolean {
    if (a == b) return true
    val now = System.currentTimeMillis()
    return TimeZone.getTimeZone(a).getOffset(now) == TimeZone.getTimeZone(b).getOffset(now)
}

@Composable
private fun Card(g: Glyph, label: String, mark: Mark, f: Found?, modifier: Modifier, onFix: () -> Unit) {
    val shown = mark == Mark.Pass || mark == Mark.Warn || mark == Mark.None
    val lift by animateFloatAsState(if (shown) 0f else 5f, tween(420), label = "lift")
    Column(
        modifier
            .clip(RoundedCornerShape(16.dp))
            .background(C.s1)
            .border(1.dp, if (mark == Mark.Warn) C.warn else C.line, RoundedCornerShape(16.dp))
            .padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 13.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).background(C.s2), contentAlignment = Alignment.Center) {
                Ic(g, 19.dp, C.ink2)
            }
            Spacer(Modifier.weight(1f))
            MarkView(mark)
        }
        Spacer(Modifier.height(10.dp))
        Txt(label, type(12.5.sp, FontWeight.SemiBold, C.ink3))
        Spacer(Modifier.height(2.dp))
        Box(Modifier.graphicsLayer { translationY = lift * density }) {
            Txt(if (shown && f != null) f.value else "Checking", type(15.5.sp, FontWeight.Bold, numbers = true), color = if (shown) C.ink else C.ink3, maxLines = 1)
        }
        Spacer(Modifier.height(2.dp))
        Row(Modifier.height(22.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Txt(if (shown && f != null) f.note else " ", type(12.sp, FontWeight.SemiBold, C.ink2), maxLines = 1, modifier = Modifier.weight(1f, fill = false))
            if (f?.fix == true && mark == Mark.Warn) {
                Box(Modifier.height(22.dp).pressable(onFix, scale = 0.95f).clip(cut(8.dp, 3.dp)).background(C.warn).padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
                    Txt("Fix", type(11.5.sp, FontWeight.ExtraBold, androidx.compose.ui.graphics.Color(0xFF1A1205)))
                }
            }
        }
    }
}

@Composable
private fun MarkView(mark: Mark) {
    when (mark) {
        Mark.Run -> {
            val t = rememberInfiniteTransition(label = "spin")
            val turn by t.animateFloat(0f, 360f, infiniteRepeatable(tween(760, easing = LinearEasing), RepeatMode.Restart), label = "turn")
            Canvas(Modifier.size(22.dp).graphicsLayer { rotationZ = turn }) {
                val k = size.minDimension / 22f
                drawCircle(C.s3, radius = 8 * k, style = Stroke(2.4f * k))
                drawArc(C.blueInk, -90f, 90f, false, topLeft = Offset(3 * k, 3 * k), size = Size(16 * k, 16 * k), style = Stroke(2.4f * k))
            }
        }
        Mark.Pass, Mark.Warn -> {
            var start by remember { mutableStateOf(0.3f) }
            LaunchedEffect(Unit) { start = 1f }
            val k by animateFloatAsState(start, tween(520, easing = Spring), label = "land")
            Box(
                Modifier.size(22.dp).graphicsLayer {
                    scaleX = k
                    scaleY = k
                    rotationZ = (1 - k) * -36f
                }.clip(RoundedCornerShape(7.dp)).background(if (mark == Mark.Pass) C.ok else C.warn),
                contentAlignment = Alignment.Center,
            ) {
                if (mark == Mark.Pass) Ic(I.check, 15.dp, androidx.compose.ui.graphics.Color(0xFF04130B), stroke = 2.8f)
                else Txt("!", type(13.sp, FontWeight.ExtraBold, androidx.compose.ui.graphics.Color(0xFF1A1205)))
            }
        }
        Mark.Wait, Mark.None -> Box(Modifier.size(22.dp).clip(RoundedCornerShape(7.dp)).background(C.s3))
    }
}
