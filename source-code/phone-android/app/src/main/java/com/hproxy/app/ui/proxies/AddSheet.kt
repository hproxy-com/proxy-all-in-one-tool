package com.hproxy.app.ui.proxies

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.Expiry
import com.hproxy.app.engine.PlaceRef
import com.hproxy.app.engine.Targeting
import com.hproxy.app.engine.countryName
import com.hproxy.app.engine.jsonOf
import com.hproxy.app.engine.spelled
import com.hproxy.app.state.AppState
import com.hproxy.app.state.JustAdded
import com.hproxy.app.ui.ADD_FIRST
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.Shelf
import com.hproxy.app.ui.kit.Btn
import com.hproxy.app.ui.kit.BtnKind
import com.hproxy.app.ui.kit.Glyph
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.IconBtn
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.kit.slideWith
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type
import kotlinx.coroutines.launch
import org.json.JSONObject

private enum class AddMode { Start, Type, Name }

/** A paste, read by the engine (proxy-engine/hproxy-mobile, places.rs `review`). */
private data class Review(
    val proxies: Int,
    val unreadable: Int,
    val sessions: Int,
    val shared: Targeting,
    val logins: Int,
    val saved: Int,
) {
    /** Many sessions of one login: they belong together, as a group. */
    val group: Boolean get() = sessions > 1 && proxies > 1

    companion object {
        fun of(o: JSONObject) = Review(
            proxies = o.optInt("proxies"),
            unreadable = o.optInt("unreadable"),
            sessions = o.optInt("sessions"),
            shared = Targeting.of(o.optJSONObject("shared")) ?: Targeting(),
            logins = o.optInt("logins"),
            saved = o.optInt("saved"),
        )
    }
}

private suspend fun reviewOf(text: String): Review? = if (text.isBlank()) null else try {
    Review.of(Engine.obj("review", jsonOf("text" to text)))
} catch (e: EngineError) {
    null
}

private fun clipboardText(context: Context): String? {
    val cm = context.getSystemService(ClipboardManager::class.java) ?: return null
    val desc = cm.primaryClipDescription ?: return null
    if (!desc.hasMimeType("text/*")) return null
    return cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()?.takeIf { it.isNotBlank() }
}

/** A line as it may be shown: its address, never its login. */
internal fun masked(line: String): String {
    val noScheme = line.trim().substringAfter("://")
    val at = noScheme.substringAfterLast('@')
    val parts = at.split(':')
    return if (parts.size >= 2) "${parts[0]}:${parts[1]}" else at
}

/** "Germany · 30 min each · one login": what the lines share. */
private fun sharedWords(r: Review): String = listOfNotNull(
    listOfNotNull(r.shared.city, r.shared.region).firstOrNull()?.let(::spelled) ?: countryName(r.shared.country?.lowercase()),
    r.shared.kind?.label,
    r.shared.minutes?.let { if (r.sessions > 1) "$it min each" else "$it min" },
    if (r.logins == 1 && r.proxies > 1) "one login" else null,
).joinToString(" · ")

/**
 * Adding, the way someone who keeps adding proxies wants it (the button pressed most is the one
 * that matters): what is on the clipboard is already
 * there to add with one tap; the other ways in one row, the most used (Paste) on the far right,
 * where the thumb is. Then a name for each, one by one, or one name for all of them, or Skip
 * (2026-10-11). The proxies are
 * added at once and checked from this phone while the names are typed.
 */
@Composable
fun ColumnScope.AddSheet(nav: Nav) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var mode by remember { mutableStateOf(AddMode.Start) }
    var text by remember { mutableStateOf("") }
    var clip by remember { mutableStateOf<Pair<String, Review>?>(null) }
    var review by remember { mutableStateOf<Review?>(null) }
    var adding by remember { mutableStateOf(false) }
    // What was just added: proxies one by one, or a group.
    var fresh by remember { mutableStateOf<List<String>>(emptyList()) }
    var group by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        val t = clipboardText(context) ?: return@LaunchedEffect
        val r = reviewOf(t) ?: return@LaunchedEffect
        if (r.proxies > 0) clip = t to r
    }
    // Shared from another app, or scanned: read and ready.
    LaunchedEffect(nav.incoming) {
        val got = nav.incoming ?: return@LaunchedEffect
        nav.incoming = null
        text = got
        mode = AddMode.Type
    }
    LaunchedEffect(text) { review = reviewOf(text) }

    fun add(lines: String, asGroup: Boolean) {
        if (adding) return
        adding = true
        scope.launch {
            val before = AppState.library.value.proxies.map { it.id }.toSet()
            try {
                val o = Engine.obj("add", jsonOf("text" to lines, "asGroup" to asGroup))
                o.optJSONObject("library")?.let(AppState::setLibrary)
                val added = o.optJSONObject("added")
                val ids = added?.optJSONArray("ids")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty()
                nav.showShelf(Shelf.Mine)
                if (asGroup) {
                    group = (PlaceRef.of(added?.optJSONObject("place")) as? PlaceRef.Group)?.id
                    AppState.toast("Added as a group of ${added?.optInt("count") ?: 0}")
                    mode = AddMode.Name
                } else {
                    val newOnes = ids.filter { it !in before }
                    if (newOnes.isEmpty()) {
                        AppState.toast(if (ids.size == 1) "That one is in My proxies already" else "Those are in My proxies already")
                        nav.sheet = null
                    } else {
                        JustAdded.added(newOnes)
                        fresh = newOnes
                        AppState.toast("${newOnes.size} added, checking ${if (newOnes.size == 1) "it" else "them"} now")
                        mode = AddMode.Name
                    }
                }
            } catch (e: EngineError) {
                AppState.toast(e.message ?: "They were not added")
            }
            adding = false
        }
    }

    fun paste() {
        val t = clipboardText(context)
        if (t == null) {
            AppState.toast("Nothing to paste: copy your proxies first")
        } else {
            text = t
            mode = AddMode.Type
        }
    }

    Box(Modifier.fillMaxWidth().slideWith(mode, AddMode.entries)) {
        when (mode) {
            AddMode.Start -> Start(
                clip = clip,
                asked = nav.addAsked,
                adding = adding,
                onAdd = { asGroup -> clip?.let { add(it.first, asGroup) } },
                onScan = { nav.scan { got -> text = got; mode = AddMode.Type } },
                onType = { text = ""; mode = AddMode.Type },
                onPaste = ::paste,
            )
            AddMode.Type -> Typing(
                text = text,
                onText = { text = it },
                review = review,
                adding = adding,
                onBack = { mode = AddMode.Start },
                onAdd = { asGroup -> add(text, asGroup) },
            )
            AddMode.Name -> if (group != null) {
                NameGroup(group!!, nav.askNotifications) { nav.sheet = null }
            } else {
                NameThem(fresh, nav.askNotifications) { nav.sheet = null }
            }
        }
    }
}

@Composable
private fun Start(
    clip: Pair<String, Review>?,
    asked: Boolean,
    adding: Boolean,
    onAdd: (asGroup: Boolean) -> Unit,
    onScan: () -> Unit,
    onType: () -> Unit,
    onPaste: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Txt("Add proxies", type(22.sp, FontWeight.Bold, spacing = (-0.015).em), modifier = Modifier.padding(top = 4.dp, bottom = 2.dp))
        // Opened by the switch with nothing to connect: it says why.
        if (asked) Txt(ADD_FIRST, type(15.sp, FontWeight.SemiBold, C.ink2, lineHeight = 21.sp), modifier = Modifier.padding(bottom = 4.dp))
        if (clip != null) {
            val (t, r) = clip
            val lines = t.lines().map { it.trim() }.filter { it.isNotEmpty() }
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(cut(26.dp, 9.dp))
                    .background(C.blue)
                    .padding(20.dp),
            ) {
                Ic(I.paste, 24.dp, C.white)
                Spacer(Modifier.height(10.dp))
                val what = if (r.group) "${r.sessions} sessions" else if (r.proxies == 1) "1 proxy" else "${r.proxies} proxies"
                Txt("$what on your clipboard", type(22.sp, FontWeight.Bold, C.white, spacing = (-0.015).em, numbers = true, lineHeight = 26.sp))
                Spacer(Modifier.height(6.dp))
                for (l in lines.take(3)) Txt(masked(l), type(13.5.sp, FontWeight.SemiBold, C.onBlue2, numbers = true), maxLines = 1)
                if (lines.size > 3) Txt("and ${lines.size - 3} more", type(13.5.sp, FontWeight.SemiBold, C.onBlue2, numbers = true))
                val shared = sharedWords(r)
                if (shared.isNotEmpty()) Txt(shared, type(13.5.sp, FontWeight.Bold, C.white), modifier = Modifier.padding(top = 6.dp), maxLines = 1)
                Spacer(Modifier.height(14.dp))
                if (r.group) {
                    Btn(if (adding) "Adding" else "Add as a group of ${r.sessions}", { onAdd(true) }, Modifier.fillMaxWidth(), kind = BtnKind.White)
                    Spacer(Modifier.height(8.dp))
                    Btn("Add each as its own", { onAdd(false) }, Modifier.fillMaxWidth(), kind = BtnKind.OnBlue)
                } else {
                    Btn(if (adding) "Adding" else if (r.proxies == 1) "Add it" else "Add all ${r.proxies}", { onAdd(false) }, Modifier.fillMaxWidth(), kind = BtnKind.White)
                }
            }
        } else {
            val shape = cut(26.dp, 9.dp)
            Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, C.line, shape).padding(20.dp)) {
                Ic(I.paste, 24.dp, C.ink2)
                Spacer(Modifier.height(10.dp))
                Txt("Nothing to add on your clipboard", type(19.sp, FontWeight.Bold, spacing = (-0.01).em))
                Spacer(Modifier.height(4.dp))
                Txt("Copy your proxies, then come back.", type(14.sp, FontWeight.Medium, C.ink2, lineHeight = 20.sp))
            }
        }
        Txt("Or another way", type(13.sp, FontWeight.Bold, C.ink3), modifier = Modifier.padding(start = 2.dp, top = 8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Way(I.qr, "Scan a QR", Modifier.weight(1f), onScan)
            Way(I.key, "Type one", Modifier.weight(1f), onType)
            Way(I.paste, "Paste", Modifier.weight(1f), onPaste)
        }
    }
}

/** A way in: its glyph and its word, inside a hairline. */
@Composable
internal fun Way(g: Glyph, label: String, modifier: Modifier, onClick: () -> Unit) {
    val shape = cut(18.dp, 6.dp)
    Column(
        modifier
            .height(78.dp)
            .pressable(onClick, scale = 0.96f)
            .clip(shape)
            .border(1.dp, C.line, shape),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Ic(g, 22.dp, C.ink)
        Spacer(Modifier.height(8.dp))
        Txt(label, type(13.5.sp, FontWeight.Bold), maxLines = 1)
    }
}

/** A box for many lines: proxies typed or pasted, as they are. */
@Composable
internal fun Area(text: String, onText: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier, autoFocus: Boolean = false) {
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    LaunchedEffect(Unit) { if (autoFocus) runCatching { focus.requestFocus() } }
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val line by animateColorAsState(if (focused) C.blue else C.line, tween(160), label = "areaLine")
    val shape = cut(14.dp, 5.dp)
    Box(
        modifier
            .fillMaxWidth()
            .heightIn(min = 112.dp)
            .clip(shape)
            .background(C.bg)
            .border(1.dp, line, shape)
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        if (text.isEmpty()) Txt(placeholder, type(15.sp, FontWeight.Medium, C.ink3))
        BasicTextField(
            text,
            onText,
            textStyle = type(15.sp, FontWeight.Medium, C.ink, numbers = true, lineHeight = 22.sp),
            cursorBrush = SolidColor(C.blueInk),
            interactionSource = source,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth().heightIn(min = 88.dp, max = 220.dp).focusRequester(focus),
        )
    }
}

@Composable
private fun Typing(
    text: String,
    onText: (String) -> Unit,
    review: Review?,
    adding: Boolean,
    onBack: () -> Unit,
    onAdd: (asGroup: Boolean) -> Unit,
) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
            IconBtn(I.left, onBack, Modifier.offset(x = (-10).dp), glyph = 24.dp, description = "Back")
            Txt("Type or paste them", type(22.sp, FontWeight.Bold, spacing = (-0.015).em), modifier = Modifier.offset(x = (-6).dp))
        }
        Area(text, onText, "One per line", autoFocus = text.isEmpty())
        Txt("Any format, one per line.", type(13.sp, FontWeight.SemiBold, C.ink3, lineHeight = 18.sp))
        val r = review
        if (r != null && text.isNotBlank()) {
            val found = when {
                r.proxies == 0 -> "None of these lines reads as a proxy"
                r.group -> "${r.sessions} sessions"
                r.proxies == 1 -> "1 proxy"
                else -> "${r.proxies} proxies"
            }
            val extra = listOfNotNull(
                sharedWords(r).ifEmpty { null },
                if (r.saved > 0) "${r.saved} saved already" else null,
            ).joinToString(" · ")
            Txt(listOfNotNull(found, extra.ifEmpty { null }).joinToString(" · "), type(14.sp, FontWeight.Bold, if (r.proxies == 0) C.warn else C.ink2, numbers = true))
            if (r.unreadable > 0 && r.proxies > 0) {
                Txt(
                    if (r.unreadable == 1) "1 line is not a proxy and is left out" else "${r.unreadable} lines are not proxies and are left out",
                    type(13.sp, FontWeight.SemiBold, C.warn),
                )
            }
        }
        Spacer(Modifier.height(2.dp))
        val n = r?.proxies ?: 0
        if (r != null && r.group) {
            Btn(if (adding) "Adding" else "Add as a group of ${r.sessions}", { onAdd(true) }, Modifier.fillMaxWidth())
            LineBtn("Add each as its own", { onAdd(false) }, Modifier.fillMaxWidth(), height = 52.dp)
        } else {
            Btn(
                when {
                    adding -> "Adding"
                    n == 0 -> "Type a proxy first"
                    n == 1 -> "Add it"
                    else -> "Add all $n"
                },
                { onAdd(false) },
                Modifier.fillMaxWidth(),
                enabled = n > 0 && !adding,
            )
        }
    }
}

/** One name, typed into a hairline box with what it names above it. */
@Composable
private fun NameBox(over: String, value: String, onValue: (String) -> Unit, placeholder: String) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val line by animateColorAsState(if (focused) C.blue else C.line, tween(160), label = "nameLine")
    val shape = cut(14.dp, 5.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(C.bg)
            .border(1.dp, line, shape)
            .padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Txt(over, type(12.5.sp, FontWeight.SemiBold, C.ink3, numbers = true), maxLines = 1)
        Box {
            if (value.isEmpty()) Txt(placeholder, type(16.sp, FontWeight.Medium, C.ink3), maxLines = 1)
            BasicTextField(
                value,
                { onValue(it.take(60)) },
                singleLine = true,
                textStyle = type(16.sp, FontWeight.Bold, C.ink),
                cursorBrush = SolidColor(C.blueInk),
                interactionSource = source,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** What a last day promises, said where one is set. */
private const val REMINDER_WORDS = "A last day brings a reminder 3 days before it."

/** "They expire on 14 Nov. You get a reminder 3 days before." */
private fun expiresWords(count: Int, day: String): String =
    "${if (count == 1) "It expires" else "They expire"} on ${Expiry.words(day)}. You get a reminder 3 days before."

/** The last day and the note given on the naming step, as the library's fields. */
private fun detailsOf(day: String?, note: String): Array<Pair<String, String>> =
    listOfNotNull(day?.let { "expires" to it }, note.trim().takeIf { it.isNotEmpty() }?.let { "note" to it }).toTypedArray()

/**
 * Name the proxies just added: each its own, or one name for all of them, numbered; one last day
 * and one note for all of them (a list bought at once ends at once); or Skip.
 */
@Composable
private fun NameThem(ids: List<String>, askNotifications: () -> Unit, done: () -> Unit) {
    val scope = rememberCoroutineScope()
    val library by AppState.library.collectAsState()
    val given = remember { mutableStateMapOf<String, String>() }
    // The ones named by hand keep their name when the one name for all changes.
    val byHand = remember { mutableStateListOf<String>() }
    var all by remember { mutableStateOf("") }
    var day by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    val named = ids.count { given[it]?.isNotBlank() == true }
    val described = day != null || note.isNotBlank()

    Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 20.dp)) {
        Txt("Name them", type(22.sp, FontWeight.Bold, spacing = (-0.015).em), modifier = Modifier.padding(top = 4.dp))
        Txt("Optional. $REMINDER_WORDS", type(13.sp, FontWeight.SemiBold, C.ink3, lineHeight = 18.sp), modifier = Modifier.padding(top = 2.dp, bottom = 10.dp))
        // As tall as the names, and scrolling once they fill the sheet.
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ExpiryField(day, { picked ->
                day = picked
                if (picked != null) askNotifications()
            }, label = if (ids.size > 1) "All expire on" else "Expires on")
            Field(
                note,
                { note = it.take(500) },
                placeholder = "Where they are from, what they are for",
                label = if (ids.size > 1) "Note for all" else "Note",
                height = 52.dp,
                surface = C.bg,
            )
            if (ids.size > 1) {
                NameBox("All of them", all, { v ->
                    all = v
                    val label = v.trim()
                    ids.forEachIndexed { i, id -> if (id !in byHand) given[id] = if (label.isEmpty()) "" else "$label ${i + 1}" }
                }, "One name, numbered: Shop 1, 2, 3")
            }
            for (id in ids) {
                val p = library.proxies.find { it.id == id } ?: continue
                NameBox(p.address, given[id] ?: "", { v ->
                    given[id] = v
                    if (id !in byHand) byHand.add(id)
                }, "Its own name")
            }
        }
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            LineBtn("Skip", done, Modifier.weight(1f), height = 56.dp)
            Btn(
                when {
                    saving -> "Saving"
                    described -> "Save"
                    named == 0 -> "Save names"
                    named == 1 -> "Save the name"
                    else -> "Save $named names"
                },
                {
                    if (saving) return@Btn
                    saving = true
                    scope.launch {
                        var lib: JSONObject? = null
                        for (id in ids) {
                            val name = given[id]?.trim().orEmpty()
                            if (name.isEmpty()) continue
                            try {
                                lib = Engine.obj("rename", jsonOf("id" to id, "name" to name))
                            } catch (e: EngineError) {
                                AppState.toast(e.message ?: "A name was not saved")
                            }
                        }
                        lib?.let(AppState::setLibrary)
                        // One call for all of them, however many.
                        val details = detailsOf(day, note)
                        if (details.isNotEmpty()) describe(ids, *details)
                        val picked = day
                        AppState.toast(
                            when {
                                picked != null -> expiresWords(ids.size, picked)
                                named == 0 -> "Note saved"
                                named == 1 -> "1 name saved"
                                else -> "$named names saved"
                            },
                        )
                        saving = false
                        done()
                    }
                },
                Modifier.weight(1f),
                enabled = named > 0 || described,
            )
        }
    }
}

/** Name the group just added (it came with a name made of what its sessions share), and give it
 *  its last day and a note. */
@Composable
private fun NameGroup(id: String, askNotifications: () -> Unit, done: () -> Unit) {
    val scope = rememberCoroutineScope()
    val library by AppState.library.collectAsState()
    val g = library.groups.find { it.id == id }
    var name by remember { mutableStateOf(g?.name ?: "") }
    var day by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }
    val renamed = name.isNotBlank() && name.trim() != g?.name
    val described = day != null || note.isNotBlank()
    Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 20.dp)) {
        Txt("Name the group", type(22.sp, FontWeight.Bold, spacing = (-0.015).em), modifier = Modifier.padding(top = 4.dp))
        Txt("Optional. $REMINDER_WORDS", type(13.sp, FontWeight.SemiBold, C.ink3, lineHeight = 18.sp), modifier = Modifier.padding(top = 2.dp, bottom = 10.dp))
        NameBox(g?.let { "${it.sessions.takeIf { s -> s > 0 } ?: it.size} sessions" } ?: "The group", name, { name = it }, "Its name")
        Spacer(Modifier.height(8.dp))
        ExpiryField(day, { picked ->
            day = picked
            if (picked != null) askNotifications()
        })
        Spacer(Modifier.height(8.dp))
        Field(note, { note = it.take(500) }, placeholder = "Where it is from, what it is for", label = "Note", height = 52.dp, surface = C.bg)
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            LineBtn("Skip", done, Modifier.weight(1f), height = 56.dp)
            Btn(if (described) "Save" else "Save the name", {
                scope.launch {
                    try {
                        if (renamed) AppState.setLibrary(Engine.obj("renameGroup", jsonOf("id" to id, "name" to name.trim())))
                        val details = detailsOf(day, note)
                        if (details.isNotEmpty()) describeGroup(id, *details)
                        val picked = day
                        AppState.toast(if (picked != null) expiresWords(1, picked) else if (renamed) "Name saved" else "Note saved")
                    } catch (e: EngineError) {
                        AppState.toast(e.message ?: "The name was not saved")
                    }
                    done()
                }
            }, Modifier.weight(1f), enabled = renamed || described)
        }
    }
}
