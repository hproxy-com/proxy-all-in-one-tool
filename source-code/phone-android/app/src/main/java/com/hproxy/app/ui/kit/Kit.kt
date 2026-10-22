package com.hproxy.app.ui.kit

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hproxy.app.ui.theme.AppWidth
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.CutBig
import com.hproxy.app.ui.theme.Glide
import com.hproxy.app.ui.theme.Spring
import com.hproxy.app.ui.theme.T
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type
import kotlin.math.roundToInt

/** Pressed: the thing gives a little under the finger, then springs back. No ripple: the
 *  lab's controls answer with motion, not with a wash of colour. */
@Composable
fun Modifier.pressable(onClick: () -> Unit, scale: Float = 0.975f, enabled: Boolean = true): Modifier {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val k by animateFloatAsState(if (pressed && enabled) scale else 1f, tween(160, easing = Spring), label = "press")
    return this
        .graphicsLayer {
            scaleX = k
            scaleY = k
        }
        .clickable(interactionSource = source, indication = null, enabled = enabled, onClick = onClick)
}

@Composable
fun Txt(
    text: String,
    style: TextStyle,
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
    maxLines: Int = Int.MAX_VALUE,
) {
    BasicText(
        text,
        modifier,
        style = if (color != Color.Unspecified) style.copy(color = color) else style,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
    )
}

enum class BtnKind { Blue, Raised, White, OnBlue }

/** A button cut from the H: 56 high, blue for the one thing to do, raised for the rest. */
@Composable
fun Btn(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: BtnKind = BtnKind.Blue,
    icon: Glyph? = null,
    small: Boolean = false,
    enabled: Boolean = true,
    height: Dp = if (small) 40.dp else 56.dp,
) {
    // A button that cannot be pressed looks it, whatever its kind: the quiet surface, grey words.
    val (bg, fg) = if (!enabled) {
        C.s2 to C.ink3
    } else {
        when (kind) {
            BtnKind.Blue -> C.blue to C.white
            BtnKind.Raised -> C.s2 to C.ink
            BtnKind.White -> C.white to C.blue
            BtnKind.OnBlue -> C.blueDeep to C.white
        }
    }
    val shape = if (small) cut(14.dp, 5.dp) else CutBig
    Row(
        modifier
            .height(height)
            .pressable(onClick, enabled = enabled)
            .clip(shape)
            .background(bg)
            .padding(horizontal = if (small) 14.dp else 22.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Ic(icon, if (small) 18.dp else 19.dp, fg)
            Spacer(Modifier.width(10.dp))
        }
        Txt(text, if (small) T.btn.copy(fontSize = 14.sp) else T.btn, color = fg, maxLines = 1)
    }
}

/** What a glyph button sits on, for its ink: the page (Plain) or blue (OnBlue). */
enum class IconKind { Plain, OnBlue }

/**
 * A pressable glyph: the glyph alone, its touch area and its press, never a tile behind it
 * (2026-10-11: pure icons on the buttons). Until 0.3.4 every one sat on a dark or blue square.
 */
@Composable
fun IconBtn(
    g: Glyph,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: IconKind = IconKind.Plain,
    size: Dp = 44.dp,
    glyph: Dp = 22.dp,
    description: String? = null,
    tint: Color? = null,
) {
    val fg by animateColorAsState(tint ?: if (kind == IconKind.OnBlue) C.white else C.ink, tween(300), label = "iconBtn")
    Box(
        modifier
            .size(size)
            .pressable(onClick, scale = 0.86f)
            .let { if (description != null) it.semantics { contentDescription = description } else it },
        contentAlignment = Alignment.Center,
    ) {
        Ic(g, glyph, fg)
    }
}

/** A switch whose knob is cut like the H. */
@Composable
fun Toggle(on: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val x by animateDpAsState(if (on) 22.dp else 0.dp, tween(340, easing = Spring), label = "toggle")
    val track by animateColorAsState(if (on) C.blue else C.s3, tween(260), label = "track")
    val knob by animateColorAsState(if (on) C.white else C.ink2, tween(260), label = "knob")
    Box(
        modifier
            .size(52.dp, 30.dp)
            .pressable({ onChange(!on) }, scale = 0.96f)
            .clip(cut(12.dp, 5.dp))
            .background(track),
    ) {
        Box(
            Modifier
                // Read while placing, so the slide moves the knob without composing it again.
                .offset { IntOffset((4.dp + x).roundToPx(), 4.dp.roundToPx()) }
                .size(22.dp)
                .clip(cut(9.dp, 3.dp))
                .background(knob),
        )
    }
}

/* Segments and chips (a row of choices) live in Choice.kt, with the sliding pill. */

/** Three bars, coloured by the round trip: the way every connector shows speed. */
@Composable
fun Bars(ms: Int?) {
    val lit = when {
        ms == null -> 0
        ms < 160 -> 3
        ms < 450 -> 2
        else -> 1
    }
    val colour = when {
        ms == null -> C.bad
        ms < 450 -> C.ok
        else -> C.warn
    }
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.Bottom, modifier = Modifier.height(14.dp)) {
        listOf(6.dp, 10.dp, 14.dp).forEachIndexed { i, h ->
            Box(Modifier.size(4.dp, h).clip(RoundedCornerShape(1.dp)).background(if (i < lit) colour else C.s3))
        }
    }
}

/** A group of rows on a surface (settings, fields). */
@Composable
fun Group(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(C.s1)
            .border(1.dp, C.line, RoundedCornerShape(20.dp))
            .padding(horizontal = 14.dp),
        content = content,
    )
}

/** One row of a group: an icon, words, and what sits at the end. */
@Composable
fun SettingRow(
    modifier: Modifier = Modifier,
    last: Boolean = false,
    onClick: (() -> Unit)? = null,
    content: @Composable RowScope.() -> Unit,
) {
    Column {
        Row(
            modifier
                .fillMaxWidth()
                .height(60.dp)
                .let { if (onClick != null) it.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick) else it }
                .padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            content = content,
        )
        if (!last) Box(Modifier.fillMaxWidth().height(1.dp).background(C.line))
    }
}

val settingText = type(15.5.sp, androidx.compose.ui.text.font.FontWeight.SemiBold)

/**
 * Digits that roll to their new value, like a counter; a fresh one rolls up from zeros. The text is
 * laid out once as plain text and every character keeps the place that layout gives it, so it reads
 * exactly like plain text (a narrow "1" leaves no gap after it); only the digits move, up and down.
 */
@Composable
fun RollText(text: String, style: TextStyle, color: Color, rollIn: Boolean = true) {
    val measurer = rememberTextMeasurer()
    val whole = remember(text, style) { measurer.measure(text, style, softWrap = false, maxLines = 1) }
    val lineH = with(LocalDensity.current) { whole.size.height.toDp() }
    Layout(
        // Read aloud as the one text it shows, never as the ten digits of every strip.
        modifier = Modifier.clearAndSetSemantics { contentDescription = text },
        content = {
            text.forEachIndexed { i, ch ->
                key(i) {
                    if (ch.isDigit()) RollDigit(ch - '0', i, lineH, style, color, rollIn)
                    else Txt(ch.toString(), style, color = color, maxLines = 1)
                }
            }
        },
    ) { measurables, _ ->
        val placeables = measurables.map { it.measure(Constraints()) }
        layout(whole.size.width, whole.size.height) {
            placeables.forEachIndexed { i, p -> p.place(whole.getHorizontalPosition(i, usePrimaryDirection = true).roundToInt(), 0) }
        }
    }
}

/** One digit: its strip of 0 to 9, moved up to the digit. Cut off above and below only, so a wide
 *  digit rolling past a narrow one is never cut at the sides. */
@Composable
private fun RollDigit(target: Int, index: Int, lineH: Dp, style: TextStyle, color: Color, rollIn: Boolean) {
    var shown by remember { mutableFloatStateOf(if (rollIn) 0f else target.toFloat()) }
    LaunchedEffect(target) { shown = target.toFloat() }
    val y by animateFloatAsState(shown, tween(720, delayMillis = index * 26, easing = Glide), label = "roll")
    Box(
        Modifier.height(lineH).drawWithContent {
            clipRect(left = -size.width, top = 0f, right = size.width * 2f, bottom = size.height) { this@drawWithContent.drawContent() }
        },
    ) {
        Column(
            Modifier
                .wrapContentHeight(align = Alignment.Top, unbounded = true)
                .offset { IntOffset(0, -(y * lineH.toPx()).roundToInt()) },
        ) {
            for (d in 0..9) {
                Box(Modifier.height(lineH), contentAlignment = Alignment.CenterStart) {
                    Txt(d.toString(), style, color = color, maxLines = 1)
                }
            }
        }
    }
}

/**
 * A sheet from the bottom: the screen behind dims (the one see-through thing the house rules
 * keep), the sheet glides up, a swipe down or Back closes it. `heightFraction` null: as tall as
 * what it holds, up to nearly the whole screen.
 */
@Composable
fun Sheet(open: Boolean, onClose: () -> Unit, heightFraction: Float? = 0.78f, content: @Composable ColumnScope.() -> Unit) {
    BackHandler(open, onClose)
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val tallest = maxHeight * 0.92f
        AnimatedVisibility(open, enter = fadeIn(tween(360)), exit = fadeOut(tween(360))) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color(0x99000000))
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClose),
            )
        }
        AnimatedVisibility(
            open,
            // The app's width in the middle of a big screen, clear of a bar or a cutout at the side.
            modifier = Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
            enter = slideInVertically(tween(460, easing = Glide)) { it },
            exit = slideOutVertically(tween(380, easing = Glide)) { it },
        ) {
            var drag by remember { mutableFloatStateOf(0f) }
            val dragDp = with(LocalDensity.current) { drag.toDp() }
            Column(
                Modifier
                    .widthIn(max = AppWidth)
                    .fillMaxWidth()
                    .then(if (heightFraction != null) Modifier.fillMaxHeight(heightFraction) else Modifier.heightIn(max = tallest))
                    .offset(y = dragDp)
                    .clip(RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
                    .background(C.s1)
                    .border(1.dp, C.line, RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {}
                    // Above the keyboard while one is open (a sheet with a box to type in).
                    .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime)),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(24.dp)
                        .pointerInput(Unit) {
                            detectVerticalDragGestures(
                                onDragEnd = {
                                    if (drag > 120f) onClose()
                                    drag = 0f
                                },
                                onDragCancel = { drag = 0f },
                            ) { _, d -> drag = (drag + d).coerceAtLeast(0f) }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.size(40.dp, 4.dp).clip(RoundedCornerShape(2.dp)).background(C.s3))
                }
                CompositionLocalProvider(LocalTint provides C.ink) { content() }
            }
        }
    }
}

/** A short note at the bottom, with the H in blue. It rises from behind its own foot and goes back
 *  down behind it (the box clips it): it moves, nothing fades. */
@Composable
fun BoxScope.Toast(msg: String?) {
    AnimatedVisibility(
        msg != null,
        // Above the nav (its proxy row and its tabs).
        modifier = Modifier
            .align(Alignment.BottomCenter)
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
            .widthIn(max = AppWidth)
            .navigationBarsPadding()
            .padding(start = 20.dp, end = 20.dp, bottom = 140.dp)
            .clipToBounds(),
        enter = slideInVertically(tween(460, easing = Glide)) { it },
        exit = slideOutVertically(tween(300, easing = Glide)) { it },
    ) {
        var last by remember { mutableStateOf("") }
        if (msg != null) last = msg
        Row(
            Modifier
                .fillMaxWidth()
                .clip(CutBig)
                .background(C.white)
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            HMark(16.dp, C.blue)
            Txt(last, type(14.5.sp, androidx.compose.ui.text.font.FontWeight.SemiBold, C.nearBlack))
        }
    }
}

/** The top of a page that slid in: the way back. */
@Composable
fun PushHead(onBack: () -> Unit, title: String? = null) {
    Row(
        Modifier
            .statusBarsPadding()
            .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        IconBtn(I.left, onBack, kind = IconKind.Plain, glyph = 24.dp)
        if (title != null) Txt(title, type(20.sp, androidx.compose.ui.text.font.FontWeight.Bold, spacing = (-0.015f).sp))
    }
}

@Composable
fun Line(modifier: Modifier = Modifier) = Box(modifier.fillMaxWidth().height(1.dp).background(C.line))

/** Put words on the clipboard. */
fun copy(context: android.content.Context, text: String) {
    val cm = context.getSystemService(android.content.ClipboardManager::class.java) ?: return
    cm.setPrimaryClip(android.content.ClipData.newPlainText("HProxy", text))
}

/** One line of words that grows no bigger than `style` and gets smaller, down to `smallest` sp,
 *  until it fits its width (a proxy's whole address beside the menu); cut only below that. */
@Composable
fun FitText(text: String, style: TextStyle, color: Color, modifier: Modifier = Modifier, smallest: Float = 12f) {
    BoxWithConstraints(modifier) {
        val measurer = rememberTextMeasurer()
        val room = constraints.maxWidth
        val size = remember(text, style, room) {
            var sp = style.fontSize.value
            while (sp > smallest && measurer.measure(text, style.copy(fontSize = sp.sp), maxLines = 1, softWrap = false).size.width > room) sp -= 0.5f
            sp
        }
        Txt(text, style.copy(fontSize = size.sp), color = color, maxLines = 1)
    }
}

fun Modifier.surface(shape: Shape, color: Color = C.s1, line: Boolean = true): Modifier =
    this.clip(shape).background(color).let { if (line) it.border(1.dp, C.line, shape) else it }
