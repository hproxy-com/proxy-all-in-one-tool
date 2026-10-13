package com.hproxy.app.ui.proxies

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.state.FraudAnswer
import com.hproxy.app.state.RowState
import com.hproxy.app.ui.connection.clock
import com.hproxy.app.ui.kit.Bars
import com.hproxy.app.ui.kit.Flag
import com.hproxy.app.ui.kit.Glyph
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.Glide
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type
import kotlinx.coroutines.delay

/*
 * THE PROXY CONNECTOR'S PIECES (2026-10-11: an easy list that shows each proxy's city, country
 * and fraud score), from the design: the row of one proxy, the
 * heads of a list, a sheet's row, the hairline buttons and the fields. Pure icons only: a glyph
 * never sits on a tile.
 */

/** "123 ms", "1.4 s". */
fun speedText(ms: Int): String = if (ms < 1000) "$ms ms" else if (ms < 10_000) "%.1f s".format(ms / 1000.0) else "${ms / 1000} s"

/** The computer app's bands (desktop-app/src/lib/fraud.ts fraudTone): under 25 low, 75 and over high. */
data class Band(val word: String, val color: Color)

fun band(score: Int): Band = when {
    score >= 75 -> Band("high", C.bad)
    score >= 25 -> Band("medium", C.warn)
    else -> Band("low", C.ok)
}

/** "Fraud 12" on a row, its number in the band's colour. */
@Composable
fun FraudWord(score: Int, size: Float = 12.5f) {
    val b = band(score)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Txt("Fraud ", type(size.sp, FontWeight.SemiBold, b.color), maxLines = 1)
        Txt("$score", type(size.sp, FontWeight.ExtraBold, b.color, numbers = true), maxLines = 1)
    }
}

/** What a row says while its proxy is being connected, in use or not answering; null when idle. */
@Composable
fun stateWords(state: RowState): String? = when (state) {
    is RowState.On -> connectedWords(state.since)
    is RowState.Busy -> state.words
    is RowState.Bad -> state.words
    RowState.Idle -> null
}

/** The mark at the start of the row in use: blue, red when it stopped answering. */
@Composable
fun UseMark(state: RowState, modifier: Modifier = Modifier) {
    if (state !is RowState.On && state !is RowState.Bad) return
    Box(modifier.padding(vertical = 14.dp)) {
        Box(
            Modifier
                .width(3.dp)
                .fillMaxHeight()
                .clip(RoundedCornerShape(topEnd = 3.dp, bottomEnd = 3.dp))
                .background(if (state is RowState.Bad) C.bad else C.blue),
        )
    }
}

/** "Connected · 4:12", counting while it shows. */
@Composable
fun connectedWords(since: Long?): String {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    return "Connected · " + clock(((now - (since ?: now)) / 1000).coerceAtLeast(0))
}

/**
 * One proxy: its flag, the proxy itself (or the name it was given), what it is doing or where it
 * is, how fast, and its fraud score; "⋯" opens it. Pressing the row connects (the screen decides).
 * In use, the row lifts onto the surface with a blue mark at its start; connecting, a blue line
 * grows along its foot; not answering, the mark and the words turn red. `checking`: just added,
 * its answer on its way.
 */
@Composable
fun ProxyRow(
    cc: String?,
    title: String,
    sub: String,
    state: RowState,
    ms: Int?,
    score: Int?,
    onClick: (() -> Unit)?,
    onMore: (() -> Unit)?,
    modifier: Modifier = Modifier,
    checking: Boolean = false,
    /** A proxy that cannot be used (the checker's dead ones): its name greyed. */
    dim: Boolean = false,
    /** The words under the name in their own colour (a checker's reason). */
    subTone: Color? = null,
    /** What stands at the end instead of the speed and the score (a group's "In use"). */
    end: (@Composable () -> Unit)? = null,
    /** The glyph of the last place: the power button connects (the big VPN apps' ⏻), a chevron
     *  goes into a group. */
    moreGlyph: Glyph = I.power,
    /** Its colour: blue on the proxy in use. */
    moreTint: Color? = null,
    /** What stands where the flag goes (the fastest free proxy's bolt). */
    lead: (@Composable () -> Unit)? = null,
) {
    val shape = cut(16.dp, 6.dp)
    val lifted = checking || state !is RowState.Idle
    val bg by animateColorAsState(if (lifted) C.s1 else C.bg, tween(220), label = "rowBg")
    val words = if (checking) "Checking" else stateWords(state) ?: sub
    val nameInk = when {
        state is RowState.On -> C.blueInk
        dim -> C.ink2
        else -> C.ink
    }
    val (subInk, subWeight) = when {
        checking -> C.ink2 to FontWeight.Medium
        state is RowState.On || state is RowState.Busy -> C.blueInk to FontWeight.SemiBold
        state is RowState.Bad -> C.bad to FontWeight.SemiBold
        subTone != null -> subTone to FontWeight.SemiBold
        else -> C.ink2 to FontWeight.Medium
    }
    Box(modifier.fillMaxWidth().heightIn(min = 70.dp).clip(shape).background(bg)) {
        UseMark(state, Modifier.matchParentSize())
        Row(Modifier.fillMaxWidth().heightIn(min = 70.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier
                    .weight(1f)
                    .heightIn(min = 70.dp)
                    .let { if (onClick != null && !checking) it.pressable(onClick, scale = 0.985f) else it }
                    .padding(start = 12.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                // Its country is not known until the check lands: a plain globe till then.
                if (lead != null) {
                    Box(Modifier.size(30.dp, 22.dp), contentAlignment = Alignment.Center) { lead() }
                } else if (checking || cc == null) {
                    Box(Modifier.size(30.dp, 22.dp), contentAlignment = Alignment.Center) { Ic(I.globe, 22.dp, C.ink3) }
                } else {
                    Flag(cc, 30.dp, 22.dp)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Txt(title, type(16.sp, FontWeight.Bold, spacing = (-0.01).em, numbers = true), color = nameInk, maxLines = 1)
                    Txt(words, type(13.sp, subWeight, numbers = true), color = subInk, maxLines = 1)
                }
                // The results rise in the moment the check lands.
                Box(Modifier.clipToBounds()) {
                    RiseIn(visible = !checking && (end != null || ms != null || score != null)) {
                        if (end != null) {
                            end()
                        } else {
                            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                if (ms != null) {
                                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                                        Bars(ms)
                                        Txt(speedText(ms), type(13.sp, FontWeight.SemiBold, C.ink2, numbers = true), maxLines = 1)
                                    }
                                }
                                if (score != null) FraudWord(score)
                            }
                        }
                    }
                }
            }
            if (onMore != null) {
                Box(
                    Modifier.width(40.dp).heightIn(min = 70.dp).pressable(onMore, scale = 0.86f),
                    contentAlignment = Alignment.Center,
                ) {
                    Ic(moreGlyph, if (moreGlyph === I.power) 22.dp else 20.dp, moreTint ?: if (state is RowState.On) C.blueInk else C.ink2)
                }
            } else {
                Spacer(Modifier.width(12.dp))
            }
        }
        if (state is RowState.Busy) GrowLine(Modifier.align(Alignment.BottomStart).padding(horizontal = 12.dp))
    }
}

/** What appears rises in from below its own foot (clipped by its parent); it never fades. */
@Composable
private fun RiseIn(visible: Boolean, content: @Composable () -> Unit) {
    AnimatedVisibility(
        visible = visible,
        enter = slideInVertically(tween(420, easing = Glide)) { it },
        exit = androidx.compose.animation.ExitTransition.None,
    ) {
        content()
    }
}

/** The blue line along a connecting row's foot: it grows from the start, once. */
@Composable
private fun GrowLine(modifier: Modifier) {
    val k = remember { Animatable(0f) }
    LaunchedEffect(Unit) { k.animateTo(1f, tween(1260, easing = Glide)) }
    Box(
        modifier
            .fillMaxWidth()
            .height(2.dp)
            .graphicsLayer {
                scaleX = k.value
                transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0f, 0.5f)
            }
            .clip(RoundedCornerShape(1.dp))
            .background(C.blue),
    )
}

/** The head of a part of a list: what it is, and what a tap does. */
@Composable
fun ListHead(left: String, right: String? = null, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 4.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Txt(left, type(13.sp, FontWeight.Bold, C.ink3, numbers = true), modifier = Modifier.weight(1f), maxLines = 1)
        if (right != null) Txt(right, type(13.sp, FontWeight.Bold, C.ink3, numbers = true), maxLines = 1)
    }
}

/** The big words at the top of a sheet. */
@Composable
fun SheetHead(text: String, modifier: Modifier = Modifier) {
    Txt(text, type(22.sp, FontWeight.Bold, spacing = (-0.015).em), modifier = modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 10.dp))
}

/** A choice in a sheet: what leads it, its words, a check when chosen. */
@Composable
fun SheetRow(chosen: Boolean, title: String, note: String? = null, lead: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 6.dp)
            .heightIn(min = 62.dp)
            .pressable(onClick, scale = 0.985f)
            .padding(start = 12.dp, end = 10.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (lead != null) Box(Modifier.width(30.dp), contentAlignment = Alignment.Center) { lead() }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Txt(title, type(16.sp, FontWeight.Bold, spacing = (-0.01).em), color = if (chosen) C.blueInk else C.ink, maxLines = 1)
            if (note != null) Txt(note, type(13.sp, FontWeight.Medium, C.ink2, numbers = true, lineHeight = 17.5.sp))
        }
        Box(Modifier.width(28.dp), contentAlignment = Alignment.Center) {
            if (chosen) Ic(I.check, 22.dp, C.blueInk)
        }
    }
}

/** A button drawn by its hairline alone: the quiet choice beside the blue one. */
@Composable
fun LineBtn(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: Glyph? = null,
    small: Boolean = false,
    height: Dp = if (small) 38.dp else 48.dp,
    ink: Color = C.ink,
    enabled: Boolean = true,
) {
    val shape = if (small) cut(12.dp, 4.dp) else cut(16.dp, 6.dp)
    Row(
        modifier
            .height(height)
            .pressable(onClick, scale = 0.98f, enabled = enabled)
            .clip(shape)
            .border(1.dp, C.line, shape)
            .padding(horizontal = if (small) 13.dp else 18.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val fg = if (enabled) ink else C.ink3
        if (icon != null) {
            Ic(icon, if (small) 17.dp else 20.dp, fg)
            Spacer(Modifier.width(if (small) 7.dp else 10.dp))
        }
        Txt(text, type(if (small) 13.5.sp else 15.sp, FontWeight.Bold), color = fg, maxLines = 1)
    }
}

/** Words that act, in blue: "Check", "Test". */
@Composable
fun TextBtn(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, ink: Color = C.blueInk) {
    Box(modifier.height(40.dp).pressable(onClick, scale = 0.95f).padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
        Txt(text, type(14.5.sp, FontWeight.Bold), color = ink, maxLines = 1)
    }
}

/**
 * A box to type in, its hairline blue while it has the keyboard. `label` stands before the words
 * (the proxy sheet's "Name"), `lead` is a glyph (the search). Proxies and keys are typed as they
 * are: no capitals, no corrections.
 */
@Composable
fun Field(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    label: String? = null,
    lead: Glyph? = null,
    height: Dp = 48.dp,
    surface: Color = C.s1,
    style: TextStyle = type(15.sp, FontWeight.Medium, C.ink),
    plain: Boolean = false,
    end: (@Composable () -> Unit)? = null,
    autoFocus: Boolean = false,
) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    LaunchedEffect(Unit) { if (autoFocus) runCatching { focus.requestFocus() } }
    val shape = cut(14.dp, 5.dp)
    val line by animateColorAsState(if (focused) C.blue else C.line, tween(160), label = "fieldLine")
    Row(
        modifier
            .fillMaxWidth()
            .height(height)
            .clip(shape)
            .background(surface)
            .border(1.dp, line, shape)
            .padding(start = 14.dp, end = if (end != null) 4.dp else 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (lead != null) Ic(lead, 20.dp, if (focused) C.ink2 else C.ink3)
        if (label != null) Txt(label, type(13.sp, FontWeight.Bold, C.ink3), maxLines = 1)
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty()) Txt(placeholder, style.copy(color = C.ink3, fontWeight = FontWeight.Medium), maxLines = 1)
            BasicTextField(
                value,
                onChange,
                singleLine = true,
                textStyle = style,
                cursorBrush = SolidColor(C.blueInk),
                interactionSource = source,
                keyboardOptions = if (plain) {
                    KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri)
                } else {
                    KeyboardOptions(capitalization = KeyboardCapitalization.Sentences)
                },
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
            )
        }
        if (end != null) end()
    }
}

/** A part of a sheet or page that slides up from below its own top edge (riseIn): new
 *  content moves in, it never fades. */
@Composable
fun Rise(key: Any, content: @Composable () -> Unit) {
    val k = remember(key) { Animatable(1f) }
    LaunchedEffect(key) { k.animateTo(0f, tween(460, easing = Glide)) }
    Box(Modifier.clipToBounds()) {
        Box(Modifier.graphicsLayer { translationY = k.value * 28f * density }) { content() }
    }
}

/** A line of facts: its label at the start, its value at the end. */
@Composable
fun Fact(label: String, value: @Composable () -> Unit) {
    Column {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 46.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Txt(label, type(14.5.sp, FontWeight.SemiBold, C.ink2), maxLines = 1)
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                value()
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(C.line))
    }
}

/** A fact's value in words. */
@Composable
fun FactText(text: String) {
    Txt(text, type(14.5.sp, FontWeight.Bold, numbers = true), maxLines = 1)
}

/** A fraud score as a short bar: its length the score, its colour the band. */
@Composable
fun Meter(score: Int) {
    Box(Modifier.size(64.dp, 6.dp).clip(RoundedCornerShape(3.dp)).background(C.s3)) {
        Box(
            Modifier
                .fillMaxHeight()
                .fillMaxWidth(score.coerceIn(4, 100) / 100f)
                .clip(RoundedCornerShape(3.dp))
                .background(band(score).color),
        )
    }
}

/** One checker's answer as a fact: the meter and "12 · low", or why there is none yet. */
@Composable
fun ScoreFact(name: String, answer: FraudAnswer?) {
    Fact(name) {
        val score = answer?.score
        val risk = answer?.risk?.takeIf { it.isNotBlank() }?.lowercase()
        val error = answer?.error
        when {
            score != null -> {
                Meter(score)
                val b = band(score)
                Txt("$score · ${risk ?: b.word}", type(14.5.sp, FontWeight.ExtraBold, b.color, numbers = true), maxLines = 1)
            }
            error != null -> Txt(error, type(13.sp, FontWeight.SemiBold, C.ink3), maxLines = 1)
            else -> Txt("Asking", type(13.sp, FontWeight.SemiBold, C.ink3), maxLines = 1)
        }
    }
}
