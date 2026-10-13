package com.hproxy.app.ui.help

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.state.SupportChat
import com.hproxy.app.ui.kit.HMark
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.IconBtn
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** The three ways people start: an idea, a problem, a country. */
private val STARTERS = listOf(
    "I have an idea" to "Idea: ",
    "Something broke" to "Something broke: ",
    "I need a country" to "A country I need: ",
)

private fun hhmm(at: Long): String = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(at))

/**
 * Help: talking to HProxy support, right here (2026-10-11: an idea goes to the same chat). The chat of chat.hproxy.com, the same people who answer on the website; an
 * idea from Settings lands in the box ready to finish. It says "HProxy support" and nothing else
 * about who runs it. A tab, one press away (2026-10-12: "we lowkey need it"); a tap on the messages
 * or a scroll puts the keyboard away and the nav is back (as a tab before, the keyboard hid the nav
 * and there was no way out).
 */
@Composable
fun HelpTab() {
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
    val messages by SupportChat.messages.collectAsState()
    val link by SupportChat.link.collectAsState()
    val online by SupportChat.online.collectAsState()
    val typing by SupportChat.typing.collectAsState()
    val intro by SupportChat.intro.collectAsState()
    val draft by SupportChat.draft.collectAsState()
    val list = rememberLazyListState()
    val focus = remember { FocusRequester() }

    LaunchedEffect(Unit) { SupportChat.open() }
    // What support wrote is read once it shows.
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            list.animateScrollToItem(messages.size + 1)
            if (messages.any { !it.mine }) SupportChat.read()
        }
    }
    // An idea from Settings: the box holds "Idea: " and the keyboard opens.
    LaunchedEffect(Unit) {
        if (draft.isNotEmpty()) runCatching { focus.requestFocus() }
    }

    // Scrolling the messages puts the keyboard away.
    LaunchedEffect(list.isScrollInProgress) { if (list.isScrollInProgress) focusManager.clearFocus() }
    Column(Modifier.fillMaxSize().background(C.bg).windowInsetsPadding(WindowInsets.ime)) {
        Row(Modifier.statusBarsPadding().padding(start = 20.dp, end = 20.dp, top = 6.dp).height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Txt("Help", type(30.sp, FontWeight.Bold, spacing = (-0.025).em))
        }
        LazyColumn(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                // A tap on the messages puts the keyboard away.
                .pointerInput(Unit) { detectTapGestures { focusManager.clearFocus() } },
            state = list,
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item("who") {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 4.dp)) {
                    HMark(16.dp, C.blueInk)
                    // Always these words: never a person's name, never who runs the chat.
                    val who = "HProxy support"
                    val state = when {
                        link == SupportChat.Link.Down -> "reconnecting"
                        link != SupportChat.Link.Open -> "connecting"
                        online -> "online now"
                        else -> intro?.replyTime?.trim()?.takeIf { it.isNotBlank() }?.let { t ->
                            // "1-3 minutes" reads "usually answers in 1-3 minutes"; "within a day" as it is.
                            if (t.first().isDigit() || t.startsWith("a ")) "usually answers in $t" else "usually answers $t"
                        } ?: "usually answers within a few hours"
                    }
                    Txt("$who · $state", type(13.sp, FontWeight.SemiBold, C.ink3), maxLines = 1)
                }
            }
            item("hello") {
                val hello = intro?.welcome?.takeIf { it.isNotBlank() } ?: intro?.greeting?.takeIf { it.isNotBlank() }
                    ?: "Hi! This is HProxy support. Ask us anything about your proxies, the app or an order, or tell us an idea: we answer right here."
                Bubble(hello, mine = false, at = null, sent = SupportChat.Sent.Delivered) {}
            }
            items(messages, key = { it.id }) { m ->
                Bubble(m.body, m.mine, hhmm(m.at), m.sent) { if (m.sent == SupportChat.Sent.Failed) SupportChat.retry(m) }
            }
            if (typing) item("typing") { Txt("Support is typing", type(13.sp, FontWeight.SemiBold, C.ink3)) }
        }
        Row(
            Modifier.fillMaxWidth().height(50.dp).horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for ((word, start) in STARTERS) {
                val shape = cut(12.dp, 4.dp)
                Box(
                    Modifier
                        .height(36.dp)
                        .pressable({
                            SupportChat.setDraft(start)
                            runCatching { focus.requestFocus() }
                        }, scale = 0.96f)
                        .clip(shape)
                        .border(1.dp, C.line, shape)
                        .padding(horizontal = 13.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Txt(word, type(13.5.sp, FontWeight.Bold), maxLines = 1)
                }
            }
        }
        ChatBar(draft, focus)
    }
}

@Composable
private fun Bubble(text: String, mine: Boolean, at: String?, sent: SupportChat.Sent, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth(), contentAlignment = if (mine) Alignment.CenterEnd else Alignment.CenterStart) {
        Column(
            Modifier
                .widthIn(max = 300.dp)
                .clip(if (mine) RoundedCornerShape(18.dp, 18.dp, 6.dp, 18.dp) else RoundedCornerShape(18.dp, 18.dp, 18.dp, 6.dp))
                .background(if (mine) C.blue else C.s2)
                .pressable(onClick, scale = 1f)
                .padding(start = 14.dp, end = 14.dp, top = 11.dp, bottom = 9.dp),
        ) {
            Txt(text, type(15.sp, FontWeight.Medium, if (mine) C.white else C.ink, lineHeight = 21.sp))
            val foot = when {
                sent == SupportChat.Sent.Sending -> "Sending"
                sent == SupportChat.Sent.Failed -> "Not sent · tap to send again"
                sent == SupportChat.Sent.Read && at != null -> "$at · Read"
                else -> at
            }
            if (foot != null) {
                Txt(
                    foot,
                    type(11.5.sp, FontWeight.SemiBold, if (sent == SupportChat.Sent.Failed) C.white else if (mine) C.onBlue2 else C.ink3),
                    modifier = Modifier.align(if (mine) Alignment.End else Alignment.Start).padding(top = 4.dp),
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun ChatBar(draft: String, focus: FocusRequester) {
    // The draft lives in SupportChat (Settings' "Send an idea" and the starters fill it): a new one
    // from there puts the cursor at its end; typing keeps the cursor where it is.
    var value by remember { mutableStateOf(TextFieldValue(draft, TextRange(draft.length))) }
    LaunchedEffect(draft) {
        if (draft != value.text) value = TextFieldValue(draft, TextRange(draft.length))
    }
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val line by animateColorAsState(if (focused) C.blue else C.line, tween(160), label = "chatLine")
    val send = {
        SupportChat.send(draft)
        Unit
    }
    Column(Modifier.fillMaxWidth().background(C.bg)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(C.line))
        Row(Modifier.fillMaxWidth().heightIn(min = 66.dp).padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            val shape = cut(14.dp, 5.dp)
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 46.dp)
                    .clip(shape)
                    .background(C.s1)
                    .border(1.dp, line, shape)
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (draft.isEmpty()) Txt("Write a message", type(15.sp, FontWeight.Medium, C.ink3), maxLines = 1)
                BasicTextField(
                    value,
                    {
                        value = it
                        SupportChat.setDraft(it.text)
                    },
                    textStyle = type(15.sp, FontWeight.Medium, C.ink, lineHeight = 21.sp),
                    cursorBrush = SolidColor(C.blueInk),
                    interactionSource = source,
                    maxLines = 5,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { send() }),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus),
                )
            }
            Spacer(Modifier.padding(start = 2.dp))
            IconBtn(I.send, send, description = "Send", tint = if (draft.isNotBlank()) C.blueInk else C.ink3)
        }
    }
}
