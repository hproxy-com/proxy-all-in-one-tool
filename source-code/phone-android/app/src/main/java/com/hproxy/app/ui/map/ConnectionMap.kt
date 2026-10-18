package com.hproxy.app.ui.map

import android.os.SystemClock
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hproxy.app.engine.PlaceRef
import com.hproxy.app.engine.countryName
import com.hproxy.app.state.AppState
import com.hproxy.app.state.FreeList
import com.hproxy.app.state.Phase
import com.hproxy.app.state.Settings
import com.hproxy.app.ui.kit.Flag
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.Glide
import com.hproxy.app.ui.theme.Spring
import com.hproxy.app.ui.theme.type
import kotlin.math.abs
import kotlin.math.hypot
import kotlinx.coroutines.delay

/**
 * The map of the connection, wherever it shows: at the top of the Proxies screen (2026-10-11,
 * where it zooms into the country while connecting) and behind the big switch of the connection page. Off, the map is dark and the place
 * you will appear waits under a grey pin with its flag and city. Connecting, its country lights up
 * and the camera starts down while the app checks where you appear. On, it turns blue from
 * `floodFrom` and the camera dives to the city. Switching, it stays blue and the camera rises,
 * crosses and comes down on the next place.
 *
 * `pinX`, `pinY`: where the place stands on this map, in dp. `floodFrom`: where the blue starts,
 * in this map's pixels (the knob of the big switch, the pin itself on the Proxies screen).
 */
@Composable
fun ConnectionMap(widthDp: Double, heightDp: Double, pinX: Double, pinY: Double, floodFrom: Offset?, modifier: Modifier = Modifier) {
    val phase by AppState.phase.collectAsState()
    val library by AppState.library.collectAsState()
    val status by AppState.status.collectAsState()
    val health by AppState.health.collectAsState()
    @Suppress("UNUSED_VARIABLE") val free = FreeList.list.collectAsState().value

    // Switching, the map goes with the place tapped at once: the camera leaves on the tap, not once
    // the engine has answered ("it should smoothly move countries over").
    // Read so the map draws again when any of them changes: the place, the outlines once loaded.
    @Suppress("UNUSED_VARIABLE") val read = Triple(library, status, World.ready)
    val ref = AppState.switchTarget()
    val shown = AppState.show(ref)
    val on = phase == Phase.On || phase is Phase.Switching
    val busy = phase is Phase.Connecting
    val diving = on || (phase as? Phase.Connecting)?.step == 1

    // Where the camera goes and the pin stands: the exit's own city once a probe said it; before
    // that, where the free list places a free proxy, or where this place came out last time; else
    // the middle of its country.
    val listed = (ref as? PlaceRef.Free)?.exit?.let(FreeList::find)?.takeIf { known(it.lat, it.lng) }
    val remembered = shown?.let { Settings.lastExit(it.ref.key) }?.takeIf { known(it.lat, it.lng) }
    // Once a probe answered, it alone says where the exit is.
    val probe = health?.takeIf { it.ok && on }
    val exitAt = probe?.let { h -> if (known(h.latitude, h.longitude)) h.latitude!! to h.longitude!! else null }
    val country = (probe?.countryCode ?: shown?.cc)?.let { World.byCc[it] }
    val before: Pair<Double, Double>? = listed?.let { it.lat!! to it.lng!! } ?: remembered?.let { it.lat to it.lng }
    val target: Pair<Double, Double>? = if (probe != null) exitAt ?: country?.center else before ?: country?.center
    // A city to dive to: the exit's own, or (until a probe answers) the listed or remembered one.
    val cityKnown = exitAt != null || (before != null && health == null)
    // The pin's words: the city, or the country when the IP data knows no city.
    val city = if (probe != null) probe.city ?: probe.country ?: countryName(probe.countryCode)
    else listed?.city ?: remembered?.city ?: shown?.cc?.let { countryName(it) }
    val pinCc = if (probe != null) probe.countryCode else listed?.cc ?: remembered?.cc ?: shown?.cc

    val flight = remember { Flight(camOn(20.0, 10.0, WORLD_S), widthDp) }
    val scale = when {
        target == null -> WORLD_S
        diving && cityKnown -> CITY_S
        diving -> countryScale(country, widthDp)
        else -> WORLD_S
    }
    val camTarget = target?.let { camOn(it.first, it.second, scale) } ?: camOn(20.0, 10.0, WORLD_S)
    LaunchedEffect(camTarget, World.loaded) { flight.go(camTarget) }

    // The pin stands on the place the camera goes to and rides the map while it flies there. A new
    // place (the exit's city once a probe has said it, the country when you are off) makes it come
    // up there; only closer or farther, it stays. Read here, in the composition that brings the new
    // place's words, so they never show for a frame where the old place was.
    val held = remember { HeldPlace(PinPlace(camTarget.x, camTarget.y, 0L)) }
    if (abs(camTarget.x - held.place.x) > 1e-6 || abs(camTarget.y - held.place.y) > 1e-6) {
        held.place = PinPlace(camTarget.x, camTarget.y, SystemClock.uptimeMillis())
    }
    val place = held.place

    // The lit country hands over to the next one: the old one fades out while the new one fades
    // in (dots are solid colours, only their colour moves), never off at once.
    val fade = remember { Animatable(1f) }
    var litNow by remember { mutableStateOf(pinCc) }
    var litBefore by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(pinCc) {
        if (pinCc == litNow) return@LaunchedEffect
        litBefore = litNow
        litNow = pinCc
        fade.snapTo(0f)
        fade.animateTo(1f, tween(900, easing = Glide))
        litBefore = null
    }
    val pinned = target != null
    val sceneDark = Scene(pinX, pinY, tone = Tone.Dark, lit = busy, exit = litNow, exitBefore = litBefore, litK = fade.value, pin = pinned)
    val sceneBlue = Scene(pinX, pinY, tone = Tone.Blue, lit = true, exit = litNow, exitBefore = litBefore, litK = fade.value, pin = pinned)
    val density = LocalDensity.current

    Box(modifier.fillMaxSize().background(C.bg)) {
        DotMap(flight, sceneDark, widthDp.toInt(), heightDp.toInt(), hidden = on, place = place) {
            Pin(on = busy, white = false, cc = pinCc, city = city, beat = null)
        }
        val from = floodFrom ?: with(density) { Offset(pinX.dp.toPx(), pinY.dp.toPx()) }
        val reach = with(density) { hypot(widthDp, heightDp).dp.toPx() } * 1.05f
        val radius by animateFloatAsState(if (on) reach else 0f, tween(760, easing = Glide), label = "flood")
        if (radius > 0.5f) {
            Box(
                Modifier
                    .fillMaxSize()
                    .drawWithContent {
                        val circle = Path().apply { addOval(androidx.compose.ui.geometry.Rect(from, radius)) }
                        clipPath(circle) { this@drawWithContent.drawContent() }
                    }
                    .background(C.blue),
            ) {
                DotMap(flight, sceneBlue, widthDp.toInt(), heightDp.toInt(), place = place) {
                    Pin(on = true, white = true, cc = pinCc, city = city, beat = health?.exitIp)
                }
            }
        }
    }
}

/** The pin's place, kept across compositions: written while composing, so it is a plain holder
 *  and never a state that would compose again. */
private class HeldPlace(var place: PinPlace)

/** A place on the map, unless it is missing or the nowhere at 0,0 (what an IP data source says
 *  when it knows only a country, or nothing). */
fun known(lat: Double?, lng: Double?): Boolean =
    lat != null && lng != null && !(kotlin.math.abs(lat) < 0.01 && kotlin.math.abs(lng) < 0.01)

/** How close the camera goes for a whole country: it fills most of the width. */
private fun countryScale(c: Country?, w: Double): Double {
    if (c == null) return WORLD_S * 2
    val span = (c.x1 - c.x0).toDouble().coerceAtLeast((c.y1 - c.y0).toDouble())
    return (0.7 * w / span.coerceAtLeast(0.5)).coerceIn(WORLD_S * 1.6, CITY_S / 3)
}

/**
 * The place you appear: a dot (a diamond once you are on), two rings that pulse, and its label (the
 * flag and the city). Drawn with its point at the top-left corner of its box, which the map puts on
 * the city. Every new address makes the dot hop once.
 */
@Composable
fun Pin(on: Boolean, white: Boolean, cc: String?, city: String?, beat: String?) {
    val dot by animateColorAsState(if (on || white) C.white else C.ink3, tween(400), label = "pinDot")
    val turn by animateFloatAsState(if (on) 45f else 0f, tween(520, easing = Spring), label = "pinTurn")
    var hop by remember { mutableFloatStateOf(1f) }
    LaunchedEffect(beat) {
        if (beat != null) {
            hop = 0.4f
            delay(16)
            hop = 1f
        }
    }
    val hopK by animateFloatAsState(hop, tween(620, easing = Spring), label = "hop")
    Box {
        if (on) {
            val ringInk = if (white) C.white else C.blueInk
            val t = rememberInfiniteTransition(label = "rings")
            for (i in 0..1) {
                val k by t.animateFloat(
                    0f,
                    1f,
                    infiniteRepeatable(tween(2200, easing = Glide), RepeatMode.Restart, StartOffset(i * 1100)),
                    label = "ring$i",
                )
                Box(
                    Modifier
                        .offset((-22).dp, (-22).dp)
                        .size(44.dp)
                        .graphicsLayer {
                            val s = 0.3f + k * 2.1f
                            scaleX = s
                            scaleY = s
                            // A ring is a line: lines may fade (house rules), fills never.
                            alpha = 1f - k
                        }
                        .border(2.dp, ringInk, CircleShape),
                )
            }
        }
        Box(
            Modifier
                .offset((-6).dp, (-6).dp)
                .size(12.dp)
                .graphicsLayer {
                    rotationZ = turn
                    scaleX = hopK
                    scaleY = hopK
                }
                .clip(RoundedCornerShape(3.dp))
                .background(dot),
        )
        if (city != null) {
            val shape = RoundedCornerShape(9.dp)
            Row(
                Modifier
                    .offset(16.dp, (-14).dp)
                    .height(28.dp)
                    // A new place's name: the label grows or shrinks to it, it does not jump.
                    .animateContentSize(tween(420, easing = Glide))
                    .clip(shape)
                    .background(if (white) C.white else C.s2)
                    .border(1.dp, if (white) C.white else C.line, shape)
                    .padding(start = 7.dp, end = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                if (cc != null) Flag(cc, 18.dp, 13.dp, line = false)
                Txt(city, type(13.sp, FontWeight.Bold), color = if (white) C.blue else C.ink2, maxLines = 1)
            }
        }
    }
}
