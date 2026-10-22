package com.hproxy.app.ui.kit

import android.content.Context
import android.graphics.BitmapFactory
import android.util.LruCache
import java.util.concurrent.ConcurrentHashMap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.hproxy.app.engine.Kind
import com.hproxy.app.ui.theme.C

/**
 * Proxy types, drawn (from the design's art): every place carries its type as a tile, the type's own
 * drawing (a house, a mast, an office block, a server rack, a bolt) on the type's solid colour,
 * with the country's flag pinned to its corner, so a row tells mobile, residential and datacenter
 * apart at a glance.
 */
object TypeColors {
    /** `color` the tile, `deep` the tile on a blue surface, `lit` the free bolt. Every one solid:
     *  the free tile is the app's own dark surface with an amber bolt, never amber mixed into it. */
    data class Set(val color: Color, val deep: Color, val lit: Color)

    fun of(kind: Kind): Set = when (kind) {
        Kind.Residential -> Set(Color(0xFF0158FF), Color(0xFF0A3FCC), Color(0xFFFFD66B))
        Kind.Mobile -> Set(Color(0xFF5B3FE0), Color(0xFF3C25B8), Color(0xFFFFD66B))
        Kind.Isp -> Set(Color(0xFF0B7A55), Color(0xFF075F42), Color(0xFFFFD66B))
        Kind.Datacenter, Kind.Unknown -> Set(Color(0xFF26324F), Color(0xFF1A2440), Color(0xFF2FD07F))
        Kind.Free -> Set(C.s3, C.s2, Color(0xFFF5B83D))
    }
}

private fun p(d: String): Path = PathParser().parsePathString(d).toPath()

/** Each type's glyph on the 24 grid: (path, in the ink or in the cut-out colour). */
private object Glyphs {
    val residential = listOf(
        p("M12 3 2 11.2h2.6V21h14.8v-9.8H22Z") to true,
        p("M10.2 14.6h3.6V21h-3.6zM6.6 13.2H9v2.4H6.6zM15 13.2h2.4v2.4H15z") to false,
    )
    val mobileFill = listOf(p("M12 10.4 7 21.4h2.7l2.3-5.6 2.3 5.6H17Z"), p("M10.5 6.7h3v3h-3z"))
    val mobileWaves = p("M8.9 5.1a4.4 4.4 0 0 0 0 6.2M15.1 5.1a4.4 4.4 0 0 1 0 6.2M6.4 2.6a7.8 7.8 0 0 0 0 11.2M17.6 2.6a7.8 7.8 0 0 1 0 11.2")
    val isp = listOf(
        p("M3.5 21V8h7v13ZM11.5 21V3H20v18Z") to true,
        p("M13.3 5.6h1.7v1.7h-1.7zM16.6 5.6h1.7v1.7h-1.7zM13.3 9.2h1.7v1.7h-1.7zM16.6 9.2h1.7v1.7h-1.7zM13.3 12.8h1.7v1.7h-1.7zM16.6 12.8h1.7v1.7h-1.7zM5.6 10.6h2.8v1.6H5.6zM5.6 14h2.8v1.6H5.6zM14.9 17.4h2v3.6h-2z") to false,
    )
    val datacenter = listOf(
        p("M4 2.5h16v19H4z") to true,
        p("M5.4 8.4h13.2v1.3H5.4zM5.4 14.4h13.2v1.3H5.4z") to false,
        p("M6.6 4.7h1.7v1.7H6.6zM6.6 10.7h1.7v1.7H6.6zM6.6 16.9h1.7v1.7H6.6zM11.4 4.1h2.6v3.2h-2.6zM15.2 4.1h2.6v3.2h-2.6zM11.4 10.1h2.6v3.2h-2.6zM15.2 10.1h2.6v3.2h-2.6zM11.4 16.3h2.6v3.4h-2.6zM15.2 16.3h2.6v3.4h-2.6z") to false,
    )
    val free = p("M13.4 2.5 5 13.7h6L10 21.5l9-11.6h-6.1Z")
}

/** The type's glyph, in `ink` with its cut-outs in `cut`. */
@Composable
fun TypeGlyph(kind: Kind, size: Dp, ink: Color, cut: Color) {
    Canvas(Modifier.size(size)) {
        val k = this.size.minDimension / 24f
        scale(k, k, pivot = Offset.Zero) {
            when (kind) {
                Kind.Residential -> Glyphs.residential.forEach { (path, isInk) -> drawPath(path, if (isInk) ink else cut) }
                Kind.Mobile -> {
                    Glyphs.mobileFill.forEach { drawPath(it, ink) }
                    drawPath(Glyphs.mobileWaves, ink, style = Stroke(1.8f, cap = StrokeCap.Square))
                }
                Kind.Isp -> Glyphs.isp.forEach { (path, isInk) -> drawPath(path, if (isInk) ink else cut) }
                Kind.Datacenter, Kind.Unknown -> Glyphs.datacenter.forEach { (path, isInk) -> drawPath(path, if (isInk) ink else cut) }
                Kind.Free -> drawPath(Glyphs.free, ink)
            }
        }
    }
}

/**
 * The tile: the glyph on the type's colour, the flag on its corner. `ring` is the colour the tile
 * sits on, so the flag badge reads as cut out of it; on a blue surface a blue tile would vanish, so
 * it takes its deeper colour (`onBlue`).
 */
@Composable
fun TypeTile(kind: Kind, cc: String?, size: Dp = 44.dp, ring: Color = C.s1, onBlue: Boolean = false) {
    val t = TypeColors.of(kind)
    val bg = if (onBlue) t.deep else t.color
    val ink = if (kind == Kind.Free) t.lit else C.white
    Box(Modifier.size(size)) {
        Box(
            Modifier.size(size).clip(RoundedCornerShape(size * 13f / 44f)).background(bg),
            contentAlignment = Alignment.Center,
        ) {
            TypeGlyph(kind, size * 0.56f, ink, bg)
        }
        if (cc != null) {
            val w = size * 0.44f
            val h = w * 0.75f
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .offset(6.dp, 6.dp)
                    .size(w + 4.dp, h + 4.dp)
                    .clip(RoundedCornerShape(5.dp))
                    .background(ring),
                contentAlignment = Alignment.Center,
            ) {
                Flag(cc, w, h, line = false)
            }
        }
    }
}

/** Flags: the website's set, drawn small once (tools/gen-flags.mjs), read when shown and at the
 *  size shown: halved while the half still covers its place (Android's inSampleSize), so a flag
 *  never holds more pixels than the screen shows of it. */
private object FlagCache {
    private val bitmaps = LruCache<String, ImageBitmap>(80)
    /** Each file's own width and height, read once. */
    private val sizes = ConcurrentHashMap<String, IntArray>()

    fun get(context: Context, code: String, width: Int, height: Int): ImageBitmap? {
        val file = "flags/$code.webp"
        val size = sizes.getOrPut(code) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            context.assets.open(file).use { BitmapFactory.decodeStream(it, null, bounds) }
            intArrayOf(bounds.outWidth, bounds.outHeight)
        }
        val (w, h) = width.coerceAtLeast(1) to height.coerceAtLeast(1)
        var sample = 1
        while (size[0] / (sample * 2) >= w && size[1] / (sample * 2) >= h) sample *= 2
        val key = "$code/$sample"
        bitmaps.get(key)?.let { return it }
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        return context.assets.open(file).use { BitmapFactory.decodeStream(it, null, options) }?.asImageBitmap()?.also { bitmaps.put(key, it) }
    }
}

@Composable
fun Flag(cc: String?, w: Dp = 32.dp, h: Dp = 24.dp, line: Boolean = true, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val code = cc?.lowercase()?.takeIf { it.length in 2..6 }
    val (wPx, hPx) = with(LocalDensity.current) { w.roundToPx() to h.roundToPx() }
    val bitmap = remember(code, wPx, hPx) {
        code?.let { c ->
            try {
                FlagCache.get(context, c, wPx, hPx)
            } catch (e: Exception) {
                null
            }
        }
    }
    val radius = if (h < 16.dp) 3.dp else 5.dp
    var m = modifier.size(w, h).clip(RoundedCornerShape(radius)).background(C.s2)
    if (line) m = m.border(1.dp, C.line, RoundedCornerShape(radius))
    if (bitmap != null) {
        Image(bitmap, contentDescription = null, modifier = m, contentScale = ContentScale.Crop)
    } else {
        Box(m)
    }
}
