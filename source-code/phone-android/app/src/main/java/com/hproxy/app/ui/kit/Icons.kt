package com.hproxy.app.ui.kit

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.hproxy.app.ui.theme.C

/**
 * The app's own icons, drawn for it (the design's icon set, path for path): one grid (24), one
 * stroke (1.8), square caps and sharp joins, the way the H is cut; the few filled parts are
 * squares, never dots. No icon set: stock icons were one of the things that made the old app look
 * like every template.
 */
class Glyph(val parts: List<Part>) {
    class Part(val path: Path, val fill: Boolean, val stroke: Boolean)
}

private fun p(d: String) = PathParser().parsePathString(d).toPath()

/** Stroked parts, then parts that are only filled (`fill`), then filled and stroked (`both`). */
private fun glyph(stroked: List<String>, fill: List<String> = emptyList(), both: List<String> = emptyList()) = Glyph(
    stroked.map { Glyph.Part(p(it), fill = false, stroke = true) } +
        fill.map { Glyph.Part(p(it), fill = true, stroke = false) } +
        both.map { Glyph.Part(p(it), fill = true, stroke = true) },
)

val LocalTint = compositionLocalOf { C.ink }

@Composable
fun Ic(g: Glyph, size: Dp = 24.dp, tint: Color = LocalTint.current, stroke: Float = 1.8f, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val k = this.size.minDimension / 24f
        scale(k, k, pivot = androidx.compose.ui.geometry.Offset.Zero) {
            for (part in g.parts) {
                if (part.fill) drawPath(part.path, tint, style = Fill)
                if (part.stroke) drawPath(part.path, tint, style = Stroke(width = stroke, cap = StrokeCap.Square, join = StrokeJoin.Miter))
            }
        }
    }
}

/** The brand H (public/brand-kit/mark-white.svg), 22 by 26. */
private val H_PATHS = listOf(
    p("M0 0V0C3.98547 0 7.21633 3.23086 7.21633 7.21633V26H0V0Z"),
    p("M14.2188 0h7.21633v26h-7.21633z"),
    p("M7.2349 26H0V15.9714C0 12.4548 2.85076 9.60408 6.36735 9.60408H14.2204V0H21.4367V10.4531C21.4367 13.9696 18.586 16.8204 15.0694 16.8204H7.2349V26Z"),
)

@Composable
fun HMark(size: Dp = 24.dp, tint: Color = LocalTint.current, modifier: Modifier = Modifier) {
    Canvas(modifier.size(width = size * 22f / 26f, height = size)) {
        val k = this.size.height / 26f
        scale(k, k, pivot = androidx.compose.ui.geometry.Offset.Zero) {
            for (path in H_PATHS) drawPath(path, tint)
        }
    }
}

object I {
    val next = glyph(listOf("M6 5.5 13 12l-7 6.5", "M17.5 5.5v13"))
    val places = glyph(listOf("M9.5 6.5h10M9.5 12h10M9.5 17.5h10"), fill = listOf("M4.5 5.5h2v2h-2zM4.5 11h2v2h-2zM4.5 16.5h2v2h-2z"))
    val checker = glyph(listOf("m4 7.5 2.2 2.2L10 6", "M13.5 8h7", "m4 15.5 2.2 2.2L10 14", "M13.5 16h7"))
    val you = glyph(listOf("M12 12a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z", "M4.8 20c1.2-3.4 3.9-5.2 7.2-5.2s6 1.8 7.2 5.2"))
    val plus = glyph(listOf("M12 5v14M5 12h14"))
    val search = glyph(listOf("M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z", "m15.5 15.5 4 4"))
    val close = glyph(listOf("m6.5 6.5 11 11M17.5 6.5l-11 11"))
    val down = glyph(listOf("m6.5 9.5 5.5 5.5 5.5-5.5"))
    val right = glyph(listOf("m9.5 6.5 5.5 5.5-5.5 5.5"))
    val left = glyph(listOf("M14.5 6.5 9 12l5.5 5.5"))
    val paste = glyph(listOf("M9 4h6v3H9z", "M7 5.5H5v15h14v-15h-2", "M8.5 12h7M8.5 16h4.5"))
    val qr = glyph(
        listOf("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"),
        fill = listOf("M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5z"),
        both = listOf("M6.5 6.5h1v1h-1zM16.5 6.5h1v1h-1zM6.5 16.5h1v1h-1z"),
    )
    val idea = glyph(listOf("M9 18h6M10 21h4", "M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z"))
    val phone = glyph(listOf("M7 3h10v18H7z", "M11 17.5h2"))
    val bolt = glyph(listOf("M13 3 5.5 13.5H11L10 21l8.5-11H13Z"))
    val shield = glyph(listOf("M12 3.5 5 6v5.5c0 4.3 2.9 7.8 7 9 4.1-1.2 7-4.7 7-9V6Z", "m9 12 2.2 2.2L15.5 10"))
    val check = glyph(listOf("m5 12.5 4.5 4.5L19 7.5"))
    val globe = glyph(listOf("M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z", "M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5Z"))
    val arrowDown = glyph(listOf("M12 4.5v14M6.5 13l5.5 5.5 5.5-5.5"))
    val arrowUp = glyph(listOf("M12 19.5v-14M6.5 11 12 5.5l5.5 5.5"))
    val copy = glyph(listOf("M9 9h11v11H9z", "M15 5V4H4v11h1"))
    val grid = glyph(listOf("M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z"))
    val file = glyph(listOf("M6 3h8l4.5 4.5V21H6z", "M14 3v4.5h4.5M9 12.5h6M9 16h6"))
    val again = glyph(listOf("M19 12a7 7 0 1 1-2.1-5", "M19.5 4v4.5H15"))
    val pin = glyph(listOf("M12 21s6.5-6.1 6.5-11.2a6.5 6.5 0 0 0-13 0C5.5 14.9 12 21 12 21Z"), fill = listOf("M10.6 8.4h2.8v2.8h-2.8z"))
    val dns = glyph(listOf("M4 4.5h16v6H4zM4 13.5h16v6H4z", "M13 7.7h4M13 16.7h4"), fill = listOf("M7 7h2v1.4H7zM7 16h2v1.4H7z"))
    val camera = glyph(listOf("M3.5 6.5h12v11h-12z", "m15.5 10.5 5-3v9l-5-3"))
    val clock = glyph(listOf("M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z", "M12 7.5V12l3 2"))
    val rule = glyph(listOf("M4 7h11M4 17h7", "M18 4.5v5M14.5 14.5v5", "M15 7h5M18 17h2"))
    val share = glyph(listOf("M12 15V4M7.5 8.5 12 4l4.5 4.5", "M8.5 11H5v9.5h14V11h-3.5"))
    val save = glyph(listOf("M6.5 3.5h11v17L12 16.2l-5.5 4.3z"))
    val stop = glyph(emptyList(), fill = listOf("M7 7h10v10H7z"))
    val apps = glyph(listOf("M6.5 2.5h11v19h-11z", "M10.5 18h3"), fill = listOf("M9 7h2.4v2.4H9zM12.6 7H15v2.4h-2.4zM9 10.6h2.4V13H9zM12.6 10.6H15V13h-2.4z"))
    val lock = glyph(listOf("M5.5 10.5h13v10h-13z", "M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"), fill = listOf("M11.1 14h1.8v3h-1.8z"))
    val info = glyph(listOf("M4.5 4.5h15v15h-15z", "M12 11v5.5"), fill = listOf("M11.1 7.4h1.8v1.8h-1.8z"))
    val eye = glyph(listOf("M2.5 12s3.6-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.6 6.5-9.5 6.5S2.5 12 2.5 12Z"), fill = listOf("M10.4 10.4h3.2v3.2h-3.2z"))
    val link = glyph(listOf("M9.5 14.5l5-5", "M11 7l1.8-1.8a3.9 3.9 0 0 1 5.5 5.5L16.5 12.5M13 17l-1.8 1.8a3.9 3.9 0 0 1-5.5-5.5L7.5 11.5"))
    val site = glyph(listOf("M3.5 5h17v14h-17z", "M3.5 9h17"), fill = listOf("M5.8 6.4h1.6V8H5.8zM8.6 6.4h1.6V8H8.6z"))
    // Drawn for the firewall (Which apps), in the same hand: Wi-Fi's three arcs over a square,
    // mobile data's four bars.
    val wifi = glyph(listOf("M3.8 9.4a11.6 11.6 0 0 1 16.4 0", "M6.9 12.6a7.2 7.2 0 0 1 10.2 0", "M9.9 15.8a3 3 0 0 1 4.2 0"), fill = listOf("M11 18.4h2v2h-2z"))
    val mobile = glyph(listOf("M5 20v-3.5M9.7 20v-6.5M14.3 20v-10M19 20V6.5"))
    val trash = glyph(listOf("M4.5 6.5h15", "M9 6.5V4h6v2.5", "M6.5 6.5 7.5 20h9l1-13.5", "M10 10.5v6M14 10.5v6"))
    val type = glyph(
        listOf("M3 6.5h18v11H3z", "M8 14.3h8"),
        fill = listOf("M6.35 9.2h1.7v1.7h-1.7zM9.55 9.2h1.7v1.7h-1.7zM12.75 9.2h1.7v1.7h-1.7zM15.95 9.2h1.7v1.7h-1.7z"),
    )
    // The proxy connector's (2026-10-11), from the design's icon set: Help's speech bubble, the
    // order of a list, a paper clip, send, a row's "more", a key for typing a proxy in.
    val chat = glyph(listOf("M4 4.5h16v11.5h-8.5L7 20v-4H4z", "M8 9h8M8 12.2h5"))
    val sort = glyph(listOf("M8 4.5v15M4.5 8 8 4.5 11.5 8", "M16 19.5v-15M12.5 16l3.5 3.5 3.5-3.5"))
    val attach = glyph(listOf("M17.5 11.5 11 18a4.2 4.2 0 0 1-6-6l7.2-7.2a2.8 2.8 0 0 1 4 4L9.5 15.5a1.4 1.4 0 0 1-2-2l6-6"))
    val send = glyph(listOf("M4 12h12M11 6.5l5.5 5.5-5.5 5.5", "M20 4v16"))
    val more = glyph(emptyList(), fill = listOf("M5 11h2.5v2.5H5zM10.75 11h2.5v2.5h-2.5zM16.5 11H19v2.5h-2.5z"))
    val key = glyph(listOf("M8 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M11.5 12h9M17 12v3.5M20.5 12v2.5"))
    // The connector modelled on the big VPN apps (2026-10-12): Home, the power button on every
    // row, Help beside the connection, the arrow from your IP to the proxy's.
    val home = glyph(listOf("M4 10.5 12 4l8 6.5V20H4Z", "M10 20v-5.5h4V20"))
    val power = glyph(listOf("M12 3.5V11", "M7.4 6.3a7.4 7.4 0 1 0 9.2 0"))
    val help = glyph(
        listOf("M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z", "M9.7 9.6a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.5v.5"),
        fill = listOf("M11.1 15.9h1.8v1.8h-1.8z"),
    )
    val across = glyph(listOf("M4 12h15M14 7l5 5-5 5"))
    val unlock = glyph(listOf("M5.5 10.5h13v10h-13z", "M8.5 10.5V7.5a3.5 3.5 0 0 1 6.8-1.2"), fill = listOf("M11.1 14h1.8v3h-1.8z"))
}
