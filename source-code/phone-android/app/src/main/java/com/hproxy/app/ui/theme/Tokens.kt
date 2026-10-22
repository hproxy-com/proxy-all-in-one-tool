package com.hproxy.app.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.R

/**
 * The app's one look, from the design lab (hproxy-website/components/design/phone-app,
 * phone.module.css): dark by default, every fill a solid colour (nothing see-through; the dimmed
 * screen behind an open sheet is the one exception), everything pressable cut like the H (round
 * top-left and bottom-right, nearly square at the other two).
 */
object C {
    val bg = Color(0xFF070A12)
    val s1 = Color(0xFF0E1320)
    val s2 = Color(0xFF161C2B)
    val s3 = Color(0xFF1E2537)
    val line = Color(0xFF232B3E)
    val ink = Color(0xFFF4F6FB)
    val ink2 = Color(0xFFA6AEC1)
    val ink3 = Color(0xFF6C7489)
    val blue = Color(0xFF0158FF)
    val blueDeep = Color(0xFF0A3FCC)
    val bluePress = Color(0xFF0047E0)
    val blueInk = Color(0xFF4D8BFF)
    val onBlue2 = Color(0xFFCFDEFF)
    val ok = Color(0xFF2FD07F)
    val warn = Color(0xFFF5B83D)
    val bad = Color(0xFFFF5A5F)
    val gone = Color(0xFF3A4357)
    val white = Color(0xFFFFFFFF)
    val nearBlack = Color(0xFF0B0E17)
    /** Secondary words on the white place bar. */
    val onWhite2 = Color(0xFF4F5A70)
}

/** Motion: a glide for things that move into place, a spring for things that land. */
val Glide = CubicBezierEasing(0.2f, 0.9f, 0.1f, 1f)
val Spring = CubicBezierEasing(0.34f, 1.45f, 0.6f, 1f)

/** The sliding pill's two edges (the computer app's --lead and --trail, desktop-app globals.css):
 *  the leading edge sets off at once and lands a hair past, the trailing one a little gentler and
 *  a moment later, so the pill stretches on the way and settles (ui/kit/Choice.kt). */
val Lead = CubicBezierEasing(0.25f, 0.8f, 0.3f, 1.12f)
val Trail = CubicBezierEasing(0.3f, 0.75f, 0.3f, 1f)
const val LEAD_MS = 420
const val TRAIL_MS = 440
const val TRAIL_WAIT_MS = 30

/** The H's cut: round top-left and bottom-right, nearly square at the other two. */
fun cut(big: Dp, small: Dp) = RoundedCornerShape(topStart = big, topEnd = small, bottomEnd = big, bottomStart = small)

val CutBig = cut(18.dp, 6.dp)
val CutSmall = cut(14.dp, 5.dp)

/** The widest the app gets: a phone's screens, kept to this width in the middle of a tablet, an
 *  open foldable or a Chromebook window (ui/Root.kt), the sheets and the notes too. Every phone
 *  is narrower, so on a phone nothing changes. */
val AppWidth = 600.dp

/** Inter (2026-10-11, in place of DM Sans), the
 *  Latin and Latin Extended letters of its static weights, from Google Fonts. SIL Open Font
 *  License: the licence travels in assets/licenses/Inter-OFL.txt, no credit line on any screen.
 *  Another script falls back to the phone's own font. */
val Inter = FontFamily(
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
    Font(R.font.inter_bold, FontWeight.Bold),
    Font(R.font.inter_extrabold, FontWeight.ExtraBold),
)

/** A style in the app's type: Inter, the design's weights (550 reads as medium, 650 semibold,
 *  750 bold, 800 extra bold), tabular figures where numbers stand in columns. */
fun type(
    size: TextUnit,
    weight: FontWeight = FontWeight.SemiBold,
    color: Color = C.ink,
    spacing: TextUnit = TextUnit.Unspecified,
    numbers: Boolean = false,
    lineHeight: TextUnit = TextUnit.Unspecified,
): TextStyle = TextStyle(
    fontFamily = Inter,
    fontSize = size,
    fontWeight = weight,
    color = color,
    letterSpacing = spacing,
    lineHeight = lineHeight,
    fontFeatureSettings = if (numbers) "tnum" else null,
)

object T {
    val title = type(28.sp, FontWeight.Bold, spacing = (-0.025).em, lineHeight = 31.sp)
    val rowName = type(16.sp, FontWeight.Bold, spacing = (-0.01).em)
    val rowSub = type(13.sp, FontWeight.Medium, C.ink2)
    val label = type(13.sp, FontWeight.SemiBold, C.ink2)
    val listHead = type(13.sp, FontWeight.Bold, C.ink3)
    val body = type(15.sp, FontWeight.Medium, C.ink2, lineHeight = 22.sp)
    val btn = type(16.sp, FontWeight.Bold, spacing = (-0.005).em)
}
