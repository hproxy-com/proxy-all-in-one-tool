package com.hproxy.app.ui.kit

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.Glide
import com.hproxy.app.ui.theme.LEAD_MS
import com.hproxy.app.ui.theme.Lead
import com.hproxy.app.ui.theme.Spring
import com.hproxy.app.ui.theme.TRAIL_MS
import com.hproxy.app.ui.theme.TRAIL_WAIT_MS
import com.hproxy.app.ui.theme.Trail
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/*
 * ROWS OF CHOICES WITH THE SLIDING PILL (the computer app's since 0.3.3, the extension's since 1.0.3).
 *
 * The chosen one of a row is one solid blue piece, cut like the H, that slides to the one you press:
 * both edges set off at once, the leading one quicker and landing a hair past, the trailing one a
 * moment later and gentler, so it stretches on the way and settles. Its words are white exactly
 * where the blue is, letter by letter: the row is drawn twice, its own words grey, and a white copy
 * over it shown only inside the pill. Pressing the chosen one presses the pill, words and all.
 * Until 0.3.4 the chosen piece's colour faded from grey to blue in place, and nothing moved.
 *
 *   Segments   equal parts in a track            Groups | Single | Free
 *   ChipRow    parts as wide as their words,     Idea | Problem | Other
 *              each on its own with a hairline
 *   slideWith  what a choice shows comes in from that choice's side, as a page of the computer
 *              app does from its tab
 */

private val choiceText = type(14.sp, FontWeight.Bold)

/** Where the pill is: its two edges and its height, in the row's pixels. */
private class Pill {
    val left = Animatable(0f)
    val right = Animatable(0f)
    var top by mutableStateOf(0f)
    var bottom by mutableStateOf(0f)
    var placed = false
}

/** The pill follows the chosen part: the first time it is simply there, after that it slides. */
@Composable
private fun rememberPill(target: Rect?): Pill {
    val pill = remember { Pill() }
    LaunchedEffect(target) {
        val to = target ?: return@LaunchedEffect
        pill.top = to.top
        pill.bottom = to.bottom
        if (!pill.placed) {
            pill.left.snapTo(to.left)
            pill.right.snapTo(to.right)
            pill.placed = true
            return@LaunchedEffect
        }
        val rightward = to.left > pill.left.value
        val leading = if (rightward) pill.right else pill.left
        val trailing = if (rightward) pill.left else pill.right
        coroutineScope {
            launch { leading.animateTo(if (rightward) to.right else to.left, tween(LEAD_MS, easing = Lead)) }
            launch { trailing.animateTo(if (rightward) to.left else to.right, tween(TRAIL_MS, delayMillis = TRAIL_WAIT_MS, easing = Trail)) }
        }
    }
    return pill
}

/**
 * The row itself: its parts in grey (`part` draws one part, `white` says which copy), the pill, and
 * the white copy shown only inside the pill. Every part reports where it was placed, so the pill knows
 * where to go; the copies are laid out by the same Row and stand exactly over the parts.
 */
@Composable
private fun <K> PillRow(
    value: K,
    options: List<Pair<K, String>>,
    onChange: (K) -> Unit,
    pillShape: Shape,
    modifier: Modifier,
    rowModifier: Modifier,
    gap: Int,
    part: @Composable RowScope.(label: String, white: Boolean, partModifier: Modifier) -> Unit,
) {
    val bounds = remember { mutableStateMapOf<Int, Rect>() }
    val sources = remember(options.size) { List(options.size) { MutableInteractionSource() } }
    val none = remember { MutableInteractionSource() }
    val chosen = options.indexOfFirst { it.first == value }
    val pill = rememberPill(bounds[chosen])
    val pressed by (sources.getOrNull(chosen) ?: none).collectIsPressedAsState()
    val give by animateFloatAsState(if (pressed) 0.955f else 1f, tween(if (pressed) 90 else 420, easing = if (pressed) Glide else Spring), label = "pillPress")
    // The pill and its words press around the pill's middle.
    val pressLayer = Modifier.graphicsLayer {
        scaleX = give
        scaleY = give
        val mid = (pill.left.value + pill.right.value) / 2f
        transformOrigin = TransformOrigin(if (size.width > 0f) mid / size.width else 0.5f, 0.5f)
    }

    Box(modifier) {
        // The parts, grey, each one pressable.
        Row(rowModifier, horizontalArrangement = Arrangement.spacedBy(gap.dp)) {
            options.forEachIndexed { i, (k, label) ->
                part(
                    label,
                    false,
                    Modifier
                        .onPlaced { c ->
                            val p = c.positionInParent()
                            bounds[i] = Rect(p.x, p.y, p.x + c.size.width, p.y + c.size.height)
                        }
                        .clickable(interactionSource = sources[i], indication = null, role = Role.Tab) { onChange(k) },
                )
            }
        }
        // The pill, drawn at its edges: a slide only draws again, it never lays out or composes.
        Box(
            Modifier
                .matchParentSize()
                .then(pressLayer)
                .drawBehind {
                    val l = pill.left.value
                    val w = pill.right.value - l
                    val h = pill.bottom - pill.top
                    if (w <= 0f || h <= 0f) return@drawBehind
                    val outline = pillShape.createOutline(Size(w, h), layoutDirection, this)
                    translate(l, pill.top) { drawOutline(outline, C.blue) }
                },
        )
        // The white copy, shown inside the pill only. Not read aloud a second time.
        Row(
            rowModifier
                .then(pressLayer)
                .drawWithContent { clipRect(pill.left.value, pill.top, pill.right.value, pill.bottom) { this@drawWithContent.drawContent() } }
                .clearAndSetSemantics {},
            horizontalArrangement = Arrangement.spacedBy(gap.dp),
        ) {
            options.forEach { (_, label) -> part(label, true, Modifier) }
        }
    }
}

/** A segmented choice: equal parts in a track, the chosen one the sliding pill. */
@Composable
fun <K> Segments(value: K, options: List<Pair<K, String>>, onChange: (K) -> Unit, modifier: Modifier = Modifier) {
    val track = cut(16.dp, 6.dp)
    PillRow(
        value,
        options,
        onChange,
        pillShape = cut(12.dp, 4.dp),
        modifier = modifier
            .fillMaxWidth()
            .clip(track)
            .background(C.s1)
            .border(1.dp, C.line, track)
            .padding(4.dp),
        rowModifier = Modifier.fillMaxWidth(),
        gap = 4,
    ) { label, white, partModifier ->
        Box(partModifier.weight(1f).height(38.dp), contentAlignment = Alignment.Center) {
            Txt(label, choiceText, color = if (white) C.white else C.ink2, maxLines = 1)
        }
    }
}

/**
 * Choices as wide as their words, each on its own with a hairline, the chosen one the sliding pill.
 * `scroll` lets a row wider than the screen scroll sideways, the pill with it.
 */
@Composable
fun <K> ChipRow(
    value: K,
    options: List<Pair<K, String>>,
    onChange: (K) -> Unit,
    modifier: Modifier = Modifier,
    scroll: ScrollState? = null,
) {
    val shape = cut(13.dp, 5.dp)
    PillRow(
        value,
        options,
        onChange,
        pillShape = shape,
        modifier = if (scroll != null) modifier.horizontalScroll(scroll) else modifier,
        rowModifier = Modifier,
        gap = 6,
    ) { label, white, partModifier ->
        Box(
            partModifier
                .height(38.dp)
                .clip(shape)
                // The white copy carries no surface of its own: the pill is its ground.
                .then(if (white) Modifier else Modifier.background(C.s1).border(1.dp, C.line, shape))
                .padding(horizontal = 16.dp),
            contentAlignment = Alignment.Center,
        ) {
            Txt(label, choiceText, color = if (white) C.white else C.ink2, maxLines = 1)
        }
    }
}

/**
 * What a choice shows comes in from that choice's side (the computer app's pages do so from their
 * tab): a choice to the right of the last one brings its content in from the right, one to the left
 * from the left. It moves, nothing fades. The first showing stands still.
 */
@Composable
fun <K> Modifier.slideWith(value: K, order: List<K>): Modifier {
    val px = with(LocalDensity.current) { 44.dp.toPx() }
    val last = remember { mutableStateOf(value) }
    // Made while composing the new choice, so its very first frame already stands to the side.
    val shift = remember(value) {
        val was = last.value
        Animatable(
            when {
                was == value -> 0f
                order.indexOf(value) > order.indexOf(was) -> px
                else -> -px
            },
        )
    }
    LaunchedEffect(value) {
        last.value = value
        shift.animateTo(0f, tween(520, easing = Glide))
    }
    return this.graphicsLayer { translationX = shift.value }
}
