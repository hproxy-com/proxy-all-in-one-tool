package com.hproxy.app.ui.map

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import android.content.Context
import android.os.SystemClock
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.asinh
import kotlin.math.atan
import kotlin.math.cosh
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sinh
import kotlin.math.sqrt
import kotlin.math.tan
import kotlin.math.tanh
import org.json.JSONObject

/**
 * The world for the dot map (ported from the design's map): every country's real outline
 * (world-land.json, from the location pages' Natural Earth data) in Web Mercator, the projection
 * phone maps use, so a close-up is never stretched and moving the camera is a plain move and zoom.
 */
private const val RAD = PI / 180.0

/** A latitude as Web Mercator's y, in degrees. The map stops at ±85°. */
fun mercY(lat: Double): Double {
    val p = lat.coerceIn(-85.0, 85.0) * RAD
    return ln(tan(PI / 4 + p / 2)) / RAD
}

/** Web Mercator's y back to a latitude. */
fun latOf(y: Double): Double = (2 * atan(exp(y * RAD)) - PI / 2) / RAD

/** A camera over the world: its centre in Mercator degrees, its scale in dp per degree. */
data class Cam(val x: Double, val y: Double, val s: Double)

fun camOn(lat: Double, lng: Double, s: Double) = Cam(lng, mercY(lat), s)

/** The world view the app starts in, and the place the camera dives to once you are on: the
 *  region around the city, about 850 km across the screen, its coasts and borders still there.
 *  Deeper (270 km) left nothing but a grid of dots on a phone, and the dive felt too violent
 *  (2026-10-12). */
const val WORLD_S = 1500.0 / 360.0
const val CITY_S = 44.0
/** Between the two: a country, while the app checks where you appear. */
const val COUNTRY_S = 22.0

fun wrap180(d: Double): Double = ((((d + 180) % 360) + 360) % 360) - 180

class Ring(val pts: FloatArray, val x0: Float, val y0: Float, val x1: Float, val y1: Float)

class Country(val cc: String, val rings: List<Ring>, val x0: Float, val y0: Float, val x1: Float, val y1: Float) {
    /** The outline as one shape, in Mercator degrees, for the land mask. */
    val path: android.graphics.Path = android.graphics.Path().apply {
        fillType = android.graphics.Path.FillType.EVEN_ODD
        for (r in rings) {
            val p = r.pts
            moveTo(p[0], p[1])
            var k = 2
            while (k < p.size) {
                lineTo(p[k], p[k + 1])
                k += 2
            }
            close()
        }
    }

    /** Where the camera goes for this country before the exit's own city is known: the middle of
     *  its biggest piece of land. */
    val center: Pair<Double, Double> by lazy {
        var best: Ring? = null
        var bestArea = -1.0
        for (r in rings) {
            val a = abs(area(r.pts))
            if (a > bestArea) {
                bestArea = a
                best = r
            }
        }
        val r = best ?: return@lazy (0.0 to 0.0)
        var cx = 0.0
        var cy = 0.0
        var a2 = 0.0
        val p = r.pts
        var i = 0
        while (i < p.size) {
            val j = (i + 2) % p.size
            val cross = p[i].toDouble() * p[j + 1] - p[j].toDouble() * p[i + 1]
            a2 += cross
            cx += (p[i] + p[j]) * cross
            cy += (p[i + 1] + p[j + 1]) * cross
            i += 2
        }
        if (abs(a2) < 1e-9) return@lazy (latOf(((r.y0 + r.y1) / 2).toDouble()) to ((r.x0 + r.x1) / 2).toDouble())
        val x = cx / (3 * a2)
        val y = cy / (3 * a2)
        latOf(y) to x
    }

    private fun area(p: FloatArray): Double {
        var s = 0.0
        var i = 0
        while (i < p.size) {
            val j = (i + 2) % p.size
            s += p[i].toDouble() * p[j + 1] - p[j].toDouble() * p[i + 1]
            i += 2
        }
        return s / 2
    }

    /** Even-odd over the rings, so a lake or an enclave stays out. */
    fun inside(x: Double, y: Double): Boolean {
        val xx = x - Math.round((x - (x0 + x1) / 2.0) / 360.0) * 360.0
        if (xx < x0 || xx > x1 || y < y0 || y > y1) return false
        var hit = false
        for (r in rings) {
            if (xx < r.x0 || xx > r.x1 || y < r.y0 || y > r.y1) continue
            val p = r.pts
            var a = 0
            var b = p.size - 2
            while (a < p.size) {
                val ya = p[a + 1].toDouble()
                val yb = p[b + 1].toDouble()
                if ((ya > y) != (yb > y) && xx < (p[b] - p[a]) * (y - ya) / (yb - ya) + p[a]) hit = !hit
                b = a
                a += 2
            }
        }
        return hit
    }
}

object World {
    @Volatile var countries: List<Country> = emptyList()
        private set
    @Volatile var byCc: Map<String, Country> = emptyMap()
        private set

    val loaded: Boolean get() = countries.isNotEmpty()

    /** Loaded, as the screens read it: a map drawn before the outlines were read draws again with
     *  its country and its pin once they are (MainActivity sets it on the screen's thread). */
    var ready by androidx.compose.runtime.mutableStateOf(false)

    /** Read the outlines once (off the screen's thread: about 90 KB of encoded lines). */
    @Synchronized
    fun load(context: Context) {
        if (loaded) return
        val text = context.assets.open("world-land.json").bufferedReader().use { it.readText() }
        val o = JSONObject(text)
        val list = ArrayList<Country>()
        for (cc in o.keys()) {
            val arr = o.getJSONArray(cc)
            val rings = ArrayList<Ring>()
            var cx0 = Float.MAX_VALUE
            var cy0 = Float.MAX_VALUE
            var cx1 = -Float.MAX_VALUE
            var cy1 = -Float.MAX_VALUE
            for (k in 0 until arr.length()) {
                val raw = decode(arr.getString(k))
                val pts = FloatArray(raw.size)
                var x0 = Float.MAX_VALUE
                var y0 = Float.MAX_VALUE
                var x1 = -Float.MAX_VALUE
                var y1 = -Float.MAX_VALUE
                var n = 0
                while (n < raw.size) {
                    val x = raw[n].toFloat()
                    val y = mercY(raw[n + 1]).toFloat()
                    pts[n] = x
                    pts[n + 1] = y
                    x0 = min(x0, x)
                    x1 = max(x1, x)
                    y0 = min(y0, y)
                    y1 = max(y1, y)
                    n += 2
                }
                if (pts.size < 6) continue
                rings.add(Ring(pts, x0, y0, x1, y1))
                cx0 = min(cx0, x0)
                cy0 = min(cy0, y0)
                cx1 = max(cx1, x1)
                cy1 = max(cy1, y1)
            }
            if (rings.isNotEmpty()) list.add(Country(cc.lowercase(), rings, cx0, cy0, cx1, cy1))
        }
        byCc = list.associateBy { it.cc }
        countries = list
    }

    /** One ring from its encoded polyline: longitude, latitude, in turn, in hundredths. */
    private fun decode(text: String): DoubleArray {
        val out = ArrayList<Double>(text.length / 2)
        var i = 0
        var lng = 0
        var lat = 0
        while (i < text.length) {
            for (axis in 0..1) {
                var bits = 0
                var shift = 0
                var b: Int
                do {
                    b = text[i++].code - 63
                    bits = bits or ((b and 0x1f) shl shift)
                    shift += 5
                } while (b >= 0x20)
                val d = if (bits and 1 != 0) (bits shr 1).inv() else bits shr 1
                if (axis == 0) lng += d else lat += d
            }
            out.add(lng / 100.0)
            out.add(lat / 100.0)
        }
        return out.toDoubleArray()
    }
}

/**
 * Where the camera is, and where it is flying. Every map that shares one flight (the dark map and
 * the blue one) draws the same camera at the same moment, because the camera is a function of the
 * clock. A flight follows the smooth zoom-and-pan path of van Wijk and Nuij ("Smooth and efficient
 * zooming and panning", 2003): from one city to another it rises, crosses and comes down.
 */
class Flight(at: Cam, private val width: Double) {
    private var path: ((Double) -> Cam)? = null
    private var start = 0L
    private var ms = 0L
    /** The path's length in van Wijk and Nuij's measure: how far it feels, zoom and pan as one. */
    private var length = 0.0
    /** How fast the flight leaves, as a share of its mean speed: 0 from a standstill. A flight
     *  that takes over from a moving camera leaves at the camera's own speed. */
    private var launch = 0.0
    private var end: Cam = at
    /** Changes with every new flight, so a screen knows to start drawing frames. */
    var version = 0
        private set

    fun now(t: Long = SystemClock.uptimeMillis()): Cam {
        val p = path ?: return end
        val k = (t - start).toDouble() / ms
        return if (k >= 1) end else p(ease(max(0.0, k)))
    }

    fun moving(t: Long = SystemClock.uptimeMillis()): Boolean = path != null && t < start + ms

    /** A new place while flying (the exact city lands halfway to the country): the flight bends
     *  toward it at the speed it has, it never brakes to a stop first. */
    fun go(to: Cam) {
        val t = SystemClock.uptimeMillis()
        val here = now(t)
        val speed = speed(t)
        // Start every flight near longitude 0; the picture is the same 360° on.
        val turn = Math.round(here.x / 360.0) * 360.0
        val from = here.copy(x = here.x - turn)
        val dest = Cam(from.x + wrap180(to.x - from.x), to.y, to.s)
        val still = abs(dest.x - from.x) < 1e-6 && abs(dest.y - from.y) < 1e-6 && abs(dest.s / from.s - 1) < 1e-4
        end = dest
        if (still) {
            path = null
        } else {
            val (at, s) = zoomPath(from, dest, width)
            path = at
            start = t
            length = abs(s)
            // A little unhurried: a dive should read as a glide, never a jump.
            ms = min(3000.0, max(800.0, length * 900)).toLong()
            // Up to three times the mean speed: beyond that the curve would overshoot.
            launch = if (length > 1e-9) (speed * ms / length).coerceIn(0.0, 3.0) else 0.0
        }
        version++
    }

    /** How fast the camera moves now, in path length per millisecond. */
    private fun speed(t: Long): Double {
        if (path == null) return 0.0
        val k = (t - start).toDouble() / ms
        return if (k <= 0.0 || k >= 1.0) 0.0 else length * slope(k) / ms
    }

    /** From a standstill: smooth in and out. From a moving camera: leaves at its speed, and
     *  only slows into the end (a cubic Hermite curve, never past the end for a launch up to 3). */
    private fun ease(t: Double): Double =
        if (launch == 0.0) {
            if (t < 0.5) 4 * t * t * t else 1 - (-2 * t + 2).pow(3) / 2
        } else {
            (t * t * t - 2 * t * t + t) * launch + (-2 * t * t * t + 3 * t * t)
        }

    private fun slope(t: Double): Double =
        if (launch == 0.0) {
            if (t < 0.5) 12 * t * t else 3 * (2 - 2 * t).pow(2)
        } else {
            (3 * t * t - 4 * t + 1) * launch + (6 * t - 6 * t * t)
        }

    private fun zoomPath(a: Cam, b: Cam, width: Double): Pair<(Double) -> Cam, Double> {
        val rho = sqrt(2.0)
        val w0 = width / a.s
        val w1 = width / b.s
        val dx = b.x - a.x
        val dy = b.y - a.y
        val d2 = dx * dx + dy * dy
        if (d2 < 1e-9) {
            val s = ln(w1 / w0) / rho
            return Pair({ t: Double -> Cam(a.x, a.y, width / (w0 * exp(rho * t * s))) }, s)
        }
        val d1 = sqrt(d2)
        val r0 = -asinh((w1 * w1 - w0 * w0 + 4 * d2) / (4 * w0 * d1))
        val r1 = -asinh((w1 * w1 - w0 * w0 - 4 * d2) / (4 * w1 * d1))
        val s = (r1 - r0) / rho
        val c0 = cosh(r0)
        return Pair({ t: Double ->
            val v = rho * t * s + r0
            val u = (w0 / (2 * d1)) * (c0 * tanh(v) - sinh(r0))
            Cam(a.x + u * dx, a.y + u * dy, width / ((w0 * c0) / cosh(v)))
        }, s)
    }
}
