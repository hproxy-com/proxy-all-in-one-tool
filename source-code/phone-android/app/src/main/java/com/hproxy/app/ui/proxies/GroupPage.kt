package com.hproxy.app.ui.proxies

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.PlaceRef
import com.hproxy.app.engine.Targeting
import com.hproxy.app.engine.countryName
import com.hproxy.app.engine.jsonOf
import com.hproxy.app.engine.map
import com.hproxy.app.engine.spelled
import com.hproxy.app.state.AppState
import com.hproxy.app.state.CheckerState
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.Tab
import com.hproxy.app.ui.kit.Flag
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.IconBtn
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.type
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/** One session of a group, as the engine lists it (hproxy-places `members`). */
private data class Member(val index: Int, val address: String, val about: Targeting?)

/**
 * A group: its sessions, each its own address, so you see which one you connect to. A tap
 * connects exactly that session; the group keeps it until it stops answering. Its name can be
 * changed here, every session checked at once in the Checker, or the group removed.
 */
@Composable
fun GroupPage(nav: Nav, onBack: () -> Unit) {
    val id = nav.group ?: return
    val library by AppState.library.collectAsState()
    val conn by AppState.conn.collectAsState()
    val g = library.groups.find { it.id == id }
    val scope = rememberCoroutineScope()
    val members = remember(id) { mutableStateListOf<Member>() }
    var more by remember(id) { mutableStateOf(true) }
    var loading by remember(id) { mutableStateOf(false) }
    val list = rememberLazyListState()

    suspend fun load() {
        if (loading || !more) return
        loading = true
        try {
            val got = Engine.arr("members", jsonOf("id" to id, "from" to members.size, "count" to 50)).map {
                Member(it.optInt("index"), it.optString("address"), Targeting.of(it.optJSONObject("about")))
            }
            members.addAll(got)
            if (got.size < 50) more = false
        } catch (e: EngineError) {
            more = false
        }
        loading = false
    }
    // The next fifty as the end comes into view.
    LaunchedEffect(id) {
        snapshotFlow { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .collect { last -> if (last >= members.size - 8) load() }
    }

    if (g == null) {
        Column(Modifier.fillMaxSize().background(C.bg).statusBarsPadding()) {
            IconBtn(I.left, onBack, Modifier.padding(start = 10.dp, top = 8.dp), glyph = 26.dp, description = "Back")
            Note("This group is not here any more.")
        }
        return
    }

    var name by remember(id) { mutableStateOf(g.name) }
    LaunchedEffect(id, name) {
        if (name.trim().isEmpty() || name.trim() == g.name) return@LaunchedEffect
        delay(500)
        try {
            AppState.setLibrary(Engine.obj("renameGroup", jsonOf("id" to id, "name" to name.trim())))
        } catch (e: EngineError) {
            AppState.toast(e.message ?: "The name was not saved")
        }
    }
    // Its last day, kept when picked, and its note, a moment after the last key.
    var expires by remember(id) { mutableStateOf(g.expires) }
    var note by remember(id) { mutableStateOf(g.note ?: "") }
    LaunchedEffect(id, note) {
        if (note.trim() == (g.note ?: "").trim()) return@LaunchedEffect
        delay(500)
        describeGroup(id, "note" to note.trim())
    }
    var sure by remember(id) { mutableStateOf(false) }
    LaunchedEffect(sure) {
        if (sure) {
            delay(3000)
            sure = false
        }
    }

    val cc = g.shared.country?.lowercase()
    val where = listOfNotNull(g.shared.city, g.shared.region).firstOrNull()?.let(::spelled) ?: countryName(cc)
    val count = if (g.sessions > 0) g.sessions else g.size
    val hold = g.shared.minutes?.let { "each keeps its IP $it min" }

    Column(Modifier.fillMaxSize().background(C.bg)) {
        Row(Modifier.statusBarsPadding().padding(start = 10.dp, top = 8.dp)) {
            IconBtn(I.left, onBack, glyph = 26.dp, description = "Back")
        }
        LazyColumn(Modifier.weight(1f), state = list, contentPadding = PaddingValues(start = 8.dp, end = 8.dp, bottom = 40.dp)) {
            item("head") {
                Column(Modifier.padding(start = 12.dp, end = 12.dp, top = 2.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (cc != null) Flag(cc, 30.dp, 22.dp)
                        Txt(name.trim().ifEmpty { g.name }, type(26.sp, FontWeight.Bold, spacing = (-0.02).em), maxLines = 1)
                    }
                    Txt(
                        listOfNotNull(g.shared.kind?.label, "$count sessions", where, hold).joinToString(" · "),
                        type(14.sp, FontWeight.SemiBold, C.ink2, lineHeight = 20.sp),
                    )
                    Field(name, { name = it.take(60) }, placeholder = "Its name", label = "Name", height = 52.dp, surface = C.bg, style = type(15.5.sp, FontWeight.Bold, C.ink))
                    ExpiryField(expires, { day ->
                        expires = day
                        scope.launch { describeGroup(id, "expires" to (day ?: "")) }
                        // A last day is a reminder three days before it: Android shows it once allowed.
                        if (day != null) nav.askNotifications()
                    })
                    Field(note, { note = it.take(500) }, placeholder = "Where it is from, what it is for", label = "Note", height = 52.dp, surface = C.bg)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        LineBtn("Check all $count", {
                            scope.launch {
                                CheckerState.start(group = id)?.let(AppState::toast)
                            }
                            nav.go(Tab.Checker)
                        }, icon = I.checker, height = 42.dp)
                        Box(Modifier.weight(1f))
                        TextBtn(if (sure) "Tap again to remove it" else "Remove", {
                            if (!sure) {
                                sure = true
                                return@TextBtn
                            }
                            scope.launch {
                                try {
                                    AppState.setLibrary(Engine.obj("forgetGroup", jsonOf("id" to id)))
                                    onBack()
                                    AppState.toast("${g.name} removed")
                                } catch (e: EngineError) {
                                    AppState.toast(e.message ?: "It was not removed")
                                }
                            }
                        }, ink = C.bad)
                    }
                }
            }
            item("sessions") { ListHead("Sessions") }
            items(members, key = { it.index }) { m ->
                val st = conn.of("g:$id", m.index)
                val t = m.about
                val place = listOfNotNull(t?.city, t?.region).firstOrNull()?.let(::spelled) ?: countryName(t?.country?.lowercase()) ?: where
                ProxyRow(
                    cc = t?.country?.lowercase() ?: cc,
                    title = t?.session?.let { "Session $it" } ?: m.address,
                    sub = listOfNotNull(m.address.takeIf { t?.session != null }, place).joinToString(" · ").ifEmpty { m.address },
                    state = st,
                    ms = null,
                    score = null,
                    onClick = { go(nav, PlaceRef.Group(id), conn, m.index) },
                    onMore = { go(nav, PlaceRef.Group(id), conn, m.index) },
                )
            }
            if (!more && members.size < count) {
                item("rest") { Note("${count - members.size} more could not be read as proxies.") }
            }
        }
    }
}
