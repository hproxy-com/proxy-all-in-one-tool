package com.hproxy.app.ui.map

import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.Paint
import android.os.SystemClock
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import com.hproxy.app.ui.theme.Spring
import java.nio.ByteBuffer
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * The dot map that really zooms (from the design rounds): the dots are a grid fixed to the ground, not
 * to the screen. Going in, the grid splits in two again and again and the new dots grow out of
 * nothing between the old ones, so the closer the camera gets, the more dots there are where you
 * are. Every dot is a solid colour (house rule: nothing see-through).
 */
data class Tone(val base: Color, val mid: Color, val near: Color, val nearest: Color) {
    companion object {
        val Dark = Tone(Color(0xFF1A2132), Color(0xFF1B3B84), Color(0xFF1D55D6), Color(0xFF5D95FF))
        val Blue = Tone(Color(0xFF2A6CFF), Color(0xFF4480FF), Color(0xFF5F95FF), Color(0xFFFFFFFF))
    }
}

/** What one map draws: where the camera's centre sits on it, its grid, its colours. */
data class Scene(
    val px: Double,
    val py: Double,
    val pitch: Double = 10.0,
    val radius: Double = 3.3,
    val tone: Tone,
    /** Light the exit's country, and the dots around the pin brightest. */
    val lit: Boolean,
    val exit: String?,
    /** The country lit before [exit]: it fades out while [exit] fades in, [litK] going 0 to 1. */
    val exitBefore: String? = null,
    val litK: Float = 1f,
    /** A pin stands on the place ([PinPlace]); at rest that is (px, py). */
    val pin: Boolean,
)

/**
 * The pin's place on the world (Mercator degrees, as a camera's centre: Cam.x, Cam.y), shared by
 * every map on the screen, and since when it is there (SystemClock.uptimeMillis): a new place
 * makes the pin come up there, growing from nothing on the Spring curve. Until 0.3.8 the pin stood
 * in one spot of the screen and the map slid under it, so in a flight it pointed at whatever
 * passed under it (the computer app was fixed the same way, worldMap.ts onScreen).
 */
data class PinPlace(val x: Double, val y: Double, val since: Long)

/** How long the pin takes to come up on a new place (the knob's Spring, 520 ms). */
private const val POP_MS = 520L

/** How far the pin has come up: 0 to 1, a little past 1 and back on the way (Spring). */
fun popAt(p: PinPlace, t: Long = SystemClock.uptimeMillis()): Float =
    Spring.transform(((t - p.since).toFloat() / POP_MS).coerceIn(0f, 1f))

private fun popping(p: PinPlace, t: Long = SystemClock.uptimeMillis()): Boolean = t - p.since < POP_MS + 32

/** A point of the world (Mercator degrees) on the screen, in dp, for this camera: its copy nearest
 *  the camera, so a place across the date line is drawn where the map shows it. */
fun onScreen(at: PinPlace, cam: Cam, px: Double, py: Double): Pair<Double, Double> {
    val x = at.x + Math.round((cam.x - at.x) / 360.0) * 360.0
    return (px + (x - cam.x) * cam.s) to (py - (at.y - cam.y) * cam.s)
}

/** The grid: level k has a dot every STEP / 2^k degrees. */
private const val STEP = 2.4
private const val KMIN = -1
private const val KMAX = 6
private fun step(k: Int): Double = STEP / 2.0.pow(k)
/** How many steps a lit country's fade takes. */
private const val FADE_STEPS = 12
private val ROW = (360 / step(KMAX)).toLong()

/** Land or sea per grid point, shared by every map: positive is land, negative sea, and its size is
 *  the scale it was read at (a point read far out is read again once the camera is twice as close). */
private val LAND_AT = HashMap<Long, Double>()

private fun keyOf(i: Long, j: Long): Long = (((i % ROW) + ROW) % ROW) * 40000L + (j + 20000L)

/** Per map: which grid points are inside a lit country, per country (two while one fades). */
class Memo {
    private val inside = HashMap<String, HashMap<Long, Boolean>>()

    fun of(cc: String): HashMap<Long, Boolean> = inside.getOrPut(cc) { HashMap() }

    /** Only the countries drawn now stay remembered. */
    fun keep(a: String?, b: String?) {
        inside.keys.retainAll { it == a || it == b }
    }
}

/** Draws the map for one camera: a few thousand grid points from caches, the land drawn again only
 *  when a point has not been seen at this closeness. */
class Painter {
    private var mask: Bitmap? = null
    private var maskBuf: ByteBuffer? = null
    /** Bytes per row of the mask: Android pads a row of an alpha mask to four bytes. */
    private var stride = 0
    private val maskPaint = Paint().apply {
        isAntiAlias = true
        color = android.graphics.Color.BLACK
        style = Paint.Style.FILL
    }
    private val matrix = Matrix()
    private val dots = HashMap<Long, FloatArray>()
    private val counts = HashMap<Long, Int>()
    private val paints = HashMap<Long, Paint>()

    /** The land as a picture of the screen, at one pixel per dp. */
    private fun landMask(cam: Cam, w: Int, h: Int, px: Double, py: Double): ByteBuffer {
        val bmp = mask?.takeIf { it.width == w && it.height == h } ?: Bitmap.createBitmap(w, h, Bitmap.Config.ALPHA_8).also {
            mask = it
            stride = it.rowBytes
            maskBuf = ByteBuffer.allocate(it.rowBytes * h)
        }
        bmp.eraseColor(0)
        val canvas = android.graphics.Canvas(bmp)
        val s = cam.s
        val vx0 = cam.x - px / s - 1
        val vx1 = cam.x + (w - px) / s + 1
        val vy0 = cam.y - (h - py) / s - 1
        val vy1 = cam.y + py / s + 1
        for (c in World.countries) {
            if (c.y1 < vy0 || c.y0 > vy1) continue
            val oFrom = ceil((vx0 - c.x1) / 360).toInt()
            val oTo = floor((vx1 - c.x0) / 360).toInt()
            for (o in oFrom..oTo) {
                val ox = o * 360.0 - cam.x
                matrix.reset()
                matrix.setScale(s.toFloat(), (-s).toFloat())
                matrix.postTranslate((px + ox * s).toFloat(), (py + cam.y * s).toFloat())
                canvas.save()
                canvas.concat(matrix)
                canvas.drawPath(c.path, maskPaint)
                canvas.restore()
            }
        }
        val buf = maskBuf!!
        buf.rewind()
        bmp.copyPixelsToBuffer(buf)
        return buf
    }

    private fun group(colour: Color, r: Double, density: Float): Long {
        val rq = (r * 20).toInt().coerceAtLeast(1)
        val key = (colour.toArgb().toLong() shl 16) or rq.toLong()
        if (!paints.containsKey(key)) {
            paints[key] = Paint().apply {
                isAntiAlias = true
                color = colour.toArgb()
                strokeCap = Paint.Cap.ROUND
                strokeWidth = (rq / 20f) * 2f * density
            }
        }
        return key
    }

    private fun add(key: Long, x: Float, y: Float) {
        val n = counts[key] ?: 0
        var a = dots[key] ?: FloatArray(4096).also { dots[key] = it }
        if (n + 2 > a.size) {
            a = a.copyOf(a.size * 2)
            dots[key] = a
        }
        a[n] = x
        a[n + 1] = y
        counts[key] = n + 2
    }

    /** `pinAt`: where the pin stands on the screen this frame (onScreen), the brightest dots
     *  around it; (px, py) without one. */
    fun paint(canvas: android.graphics.Canvas, density: Float, wDp: Int, hDp: Int, cam: Cam, sc: Scene, memo: Memo, pinAt: Pair<Double, Double>? = null) {
        if (!World.loaded) return
        val s = cam.s
        val pitch = sc.pitch
        val radius = sc.radius
        var kf = KMIN
        for (k in KMIN + 1..KMAX) if (step(k) * s >= 0.5 * pitch) kf = k
        val d = step(kf)
        val grow = ((d * s - 0.5 * pitch) / (0.5 * pitch)).coerceIn(0.0, 1.0)
        val unit = 2.0.pow(KMAX - kf).toLong()

        val pad = radius / s
        val px = sc.px
        val py = sc.py
        val i0 = ceil((cam.x - px / s - pad) / d).toLong()
        val i1 = floor((cam.x + (wDp - px) / s + pad) / d).toLong()
        val j0 = ceil((cam.y - (hDp - py) / s - pad) / d).toLong()
        val j1 = floor((cam.y + py / s + pad) / d).toLong()

        val tone = sc.tone
        val exitCountry = if (sc.lit && sc.exit != null) World.byCc[sc.exit] else null
        // The country lit before, while it fades out.
        val beforeCountry =
            if (sc.lit && sc.exitBefore != null && sc.exitBefore != sc.exit && sc.litK < 1f) World.byCc[sc.exitBefore] else null
        memo.keep(exitCountry?.cc, beforeCountry?.cc)
        val inExit = exitCountry?.let { memo.of(it.cc) }
        val inBefore = beforeCountry?.let { memo.of(it.cc) }
        // The fade in a few steps, each colour a blend of two solid ones: nothing see-through,
        // and only a few paints.
        val fade = (sc.litK.coerceIn(0f, 1f) * FADE_STEPS).roundToInt() / FADE_STEPS.toFloat()
        val nearIn = lerp(tone.base, tone.near, fade)
        val midIn = lerp(tone.base, tone.mid, fade)
        val nearOut = lerp(tone.base, tone.near, 1f - fade)
        val midOut = lerp(tone.base, tone.mid, 1f - fade)
        // The glow stands around the pin, on its place, wherever the flight has the map.
        val pin = if (sc.lit && sc.pin) pinAt ?: (px to py) else null
        val nearest = 2.4 * pitch
        var buf: ByteBuffer? = null
        if (LAND_AT.size > 300_000) LAND_AT.clear()
        counts.clear()

        for (j in j0..j1) {
            val y = j * d
            val sy = py - (y - cam.y) * s
            val oddRow = (j and 1L) != 0L
            for (i in i0..i1) {
                val fresh = kf == KMIN || oddRow || (i and 1L) != 0L
                val r = if (fresh) radius * grow else radius
                if (r < 0.35) continue
                val x = i * d
                val sx = px + (x - cam.x) * s
                val k = keyOf(i * unit, j * unit)
                var land = LAND_AT[k]
                if (land == null || kotlin.math.abs(land) * 2 < s) {
                    val b = buf ?: landMask(cam, wDp, hDp, px, py).also { buf = it }
                    val mx = min(wDp - 1, max(0, floor(sx).toInt()))
                    val my = min(hDp - 1, max(0, floor(sy).toInt()))
                    land = if ((b.get(my * stride + mx).toInt() and 0xFF) >= 128) s else -s
                    // A point just past the edge was read from the edge: kept for this frame
                    // only, read properly once it is on the screen.
                    if (mx == floor(sx).toInt() && my == floor(sy).toInt()) LAND_AT[k] = land
                }
                if (land < 0) continue

                var colour = tone.base
                val litNow = exitCountry != null && inExit != null && inExit.getOrPut(k) { exitCountry.inside(x, y) }
                val litBefore = !litNow && beforeCountry != null && inBefore != null && inBefore.getOrPut(k) { beforeCountry.inside(x, y) }
                if (litNow || litBefore) {
                    val near = if (litNow) nearIn else nearOut
                    val mid = if (litNow) midIn else midOut
                    colour = if (pin != null) {
                        // Brightest by the city, then a step down, then the plain land: a glow
                        // in solid colours, so a close-up never turns one flat field.
                        val far = hypot(sx - pin.first, sy - pin.second)
                        when {
                            far < 10 * pitch -> near
                            far < 17 * pitch -> mid
                            else -> tone.base
                        }
                    } else {
                        near
                    }
                }
                if (pin != null && hypot(sx - pin.first, sy - pin.second) < nearest) colour = tone.nearest
                add(group(colour, r, density), (sx * density).toFloat(), (sy * density).toFloat())
            }
        }
        for ((g, n) in counts) {
            val a = dots[g] ?: continue
            canvas.drawPoints(a, 0, n, paints.getValue(g))
        }
    }
}

/**
 * The map on the screen. One flight can drive several maps (the dark one and, inside the blue,
 * the blue one), and each map asks for frames only while the camera is flying or the pin comes up.
 * The pin stands on its place ([place]) and rides the map in a flight: from country to country it
 * goes off with the old place and a new one comes up on the next. `hidden`: covered by something
 * solid, so it keeps its last frame and draws nothing new.
 */
@Composable
fun DotMap(
    flight: Flight,
    scene: Scene,
    widthDp: Int,
    heightDp: Int,
    hidden: Boolean = false,
    modifier: Modifier = Modifier,
    place: PinPlace? = null,
    pin: (@Composable BoxScope.() -> Unit)? = null,
) {
    val painter = remember { Painter() }
    val memo = remember { Memo() }
    var frame by remember { mutableLongStateOf(0L) }
    LaunchedEffect(flight.version, hidden, place) {
        if (hidden) return@LaunchedEffect
        frame = withFrameMillis { it }
        while (flight.moving() || (place != null && popping(place))) {
            frame = withFrameMillis { it }
        }
        frame = withFrameMillis { it }
    }
    Box(modifier.fillMaxSize()) {
        Canvas(Modifier.fillMaxSize()) {
            @Suppress("UNUSED_EXPRESSION") frame
            val cam = flight.now()
            // The pin moves with the map, on the same frame.
            val at = place?.let { onScreen(it, cam, scene.px, scene.py) }
            drawIntoCanvas { c -> painter.paint(c.nativeCanvas, density, widthDp, heightDp, cam, scene, memo, at) }
        }
        if (pin != null && scene.pin && place != null) {
            // The pin's point is the top-left corner of its box (Pin): it comes up from there.
            val up = Modifier.graphicsLayer {
                @Suppress("UNUSED_EXPRESSION") frame
                val k = popAt(place)
                scaleX = k
                scaleY = k
                transformOrigin = TransformOrigin(0f, 0f)
            }
            Layout(content = { Box(up) { pin() } }, modifier = Modifier.fillMaxSize()) { measurables, constraints ->
                val placeable = measurables.first().measure(Constraints())
                layout(constraints.maxWidth, constraints.maxHeight) {
                    // Where its place is this frame: every frame of a flight moves it.
                    @Suppress("UNUSED_EXPRESSION") frame
                    val (x, y) = onScreen(place, flight.now(), scene.px, scene.py)
                    placeable.place(IntOffset((x * density).roundToInt(), (y * density).roundToInt()))
                }
            }
        }
    }
}
