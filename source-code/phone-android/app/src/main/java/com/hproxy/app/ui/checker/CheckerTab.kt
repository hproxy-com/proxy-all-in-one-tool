package com.hproxy.app.ui.checker

import android.content.ClipboardManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.PlaceRef
import com.hproxy.app.engine.Shown
import com.hproxy.app.engine.countryName
import com.hproxy.app.engine.jsonOf
import com.hproxy.app.state.Answer
import com.hproxy.app.state.AppState
import com.hproxy.app.state.Card
import com.hproxy.app.state.CheckerState
import com.hproxy.app.state.Face
import com.hproxy.app.state.FraudScores
import com.hproxy.app.state.JudgeKind
import com.hproxy.app.state.JudgeSet
import com.hproxy.app.state.Phase
import com.hproxy.app.state.RowState
import com.hproxy.app.state.Settings
import com.hproxy.app.state.Stage
import com.hproxy.app.state.Summary
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.SheetKind
import com.hproxy.app.ui.kit.Btn
import com.hproxy.app.ui.kit.BtnKind
import com.hproxy.app.ui.kit.Flag
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.IconBtn
import com.hproxy.app.ui.kit.Segments
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.kit.copy
import com.hproxy.app.ui.proxies.Area
import com.hproxy.app.ui.proxies.Field
import com.hproxy.app.ui.proxies.LineBtn
import com.hproxy.app.ui.proxies.ListHead
import com.hproxy.app.ui.proxies.ProxyRow
import com.hproxy.app.ui.proxies.SheetHead
import com.hproxy.app.ui.proxies.SheetRow
import com.hproxy.app.ui.proxies.TextBtn
import com.hproxy.app.ui.proxies.Way
import com.hproxy.app.ui.proxies.masked
import com.hproxy.app.ui.proxies.speedText
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.Glide
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

private val OK = Color(0xFF2FD07F)
private val WARN = Color(0xFFF5B83D)
private val BAD = Color(0xFFFF5A5F)
private val GONE = Color(0xFF3A4357)
private val TURN = CubicBezierEasing(0.3f, 0.7f, 0.3f, 1f)

private fun colourOf(f: Face) = when (f) {
    Face.Good -> OK
    Face.Slow -> WARN
    Face.Dead -> GONE
    else -> BAD
}

private fun inkOf(f: Face) = when (f) {
    Face.Good -> Color(0xFF04301A)
    Face.Slow -> Color(0xFF3A2600)
    Face.Dead -> C.ink3
    else -> C.white
}

/** What a card says on its face, in two short lines. */
private fun faceWords(a: Answer): Pair<String, String> = when (a.face) {
    Face.Good -> "${a.ms ?: 0}" to "ms"
    Face.Slow -> when {
        "slow" in a.notes -> "%.1f".format((a.ms ?: 0) / 1000.0) to "s, slow"
        "wrong_country" in a.notes -> (a.cc?.uppercase() ?: "?") to "exits there"
        "tells_http_sites" in a.notes -> "http" to "shows you"
        else -> "${a.ms ?: 0}" to "ms, warn"
    }
    Face.NoHttps -> "http" to "only"
    Face.Reads -> "unsafe" to "reads it"
    Face.Blocked -> "blocked" to "by the site"
    Face.Bad -> when {
        "not_hidden" in a.notes -> "shows" to "your IP"
        "socks4_only" in a.notes -> "socks4" to "only"
        else -> "can't" to "use it"
    }
    Face.Dead -> "–" to "no reply"
}

/** The usual order of a finished run: working (fastest first), slow, unusable, not answered, dead. */
private fun rank(c: Card): Int = when (c.answer?.face) {
    null -> 3
    Face.Good -> 0
    Face.Slow -> 1
    Face.Dead -> 4
    else -> 2
}

/** Working: it carried the check, fast (green) or with a warning (amber). The count, the ranks,
 *  Copy, Save and the list all mean this one thing. */
private fun works(c: Card): Boolean = c.answer?.face == Face.Good || c.answer?.face == Face.Slow

/** The working ones in the order a finished run shows them: fast before slow, fastest first. */
private fun workingOf(cards: List<Card>): List<Card> =
    cards.filter(::works).sortedWith(compareBy({ rank(it) }, { it.answer?.ms ?: Int.MAX_VALUE }))

/** Every card in the order of a finished run. */
private fun ordered(cards: List<Card>): List<Card> =
    cards.sortedWith(compareBy<Card>({ rank(it) }, { if (rank(it) <= 1) it.answer?.ms ?: 0 else it.i }))

private enum class Show { Working, All }

/**
 * The checker (5 · Flip, the version chosen in the design rounds). Every proxy is a card,
 * face down: its flag and the end of its address. The moment its answer lands, the card turns over:
 * green with its milliseconds, amber when slow, red with the reason, grey when it never answered.
 * When the run is over, the cards make way for the proxies themselves (2026-10-11: "in the end it
 * should list the proxies itself"), working ones first, each a row to connect to. "A checker is a
 * check, they can change the judge but that's about it": the judge is its one choice.
 */
@Composable
fun CheckerTab(nav: Nav) {
    val run by CheckerState.run.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { CheckerState.refreshRecent() }
    val stage = run?.stage
    Column(Modifier.fillMaxSize().background(C.bg)) {
        Row(
            Modifier.statusBarsPadding().padding(start = 20.dp, end = 20.dp, top = 6.dp).fillMaxWidth().height(48.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Txt("Checker", type(30.sp, FontWeight.Bold, spacing = (-0.025).em), modifier = Modifier.weight(1f))
            when (stage) {
                Stage.Running -> LineBtn("Stop", { scope.launch { CheckerState.cancel() } }, icon = I.stop, small = true)
                Stage.Done -> IconBtn(I.plus, { CheckerState.reset() }, Modifier.padding(end = 0.dp), glyph = 26.dp, description = "A new check")
                else -> {}
            }
        }
        AnimatedContent(
            targetState = when (stage) {
                null, Stage.Ready -> 0
                Stage.Running -> 1
                Stage.Done -> 2
            },
            transitionSpec = { slideInVertically(tween(560, easing = Glide)) { it / 8 } togetherWith ExitTransition.None },
            modifier = Modifier.weight(1f).fillMaxWidth().clipToBounds(),
            label = "checkerStage",
        ) { s ->
            val r = run
            when {
                s == 0 || r == null -> StartPanel(nav)
                s == 1 -> FlipRun(r.cards, r.stage) { nav.card = it.i; nav.open(SheetKind.Card) }
                else -> DoneList(nav, r.cards)
            }
        }
    }
}

@Composable
private fun StartPanel(nav: Nav) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val library by AppState.library.collectAsState()
    val recent by CheckerState.recent.collectAsState()
    val judge by Settings.judge.collectAsState()
    fun start(text: String? = null, group: String? = null, saved: Boolean = false, again: Long? = null) {
        scope.launch { CheckerState.start(text, group, saved, again)?.let(AppState::toast) }
    }
    val file = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            val text = try {
                context.contentResolver.openInputStream(uri)?.use { it.bufferedReader().readText() }
            } catch (e: Exception) {
                null
            }
            if (text.isNullOrBlank()) AppState.toast("That file holds no text") else start(text)
        }
    }
    // The proxies on the clipboard: read once per new clip.
    var clip by remember { mutableStateOf<Pair<String, Int>?>(null) }
    LaunchedEffect(Unit) {
        val cm = context.getSystemService(ClipboardManager::class.java) ?: return@LaunchedEffect
        val desc = cm.primaryClipDescription ?: return@LaunchedEffect
        if (!desc.hasMimeType("text/*")) return@LaunchedEffect
        val stamp = if (Build.VERSION.SDK_INT >= 26) desc.timestamp else 0L
        if (stamp != 0L && stamp == Settings.clipboardSeenAt) return@LaunchedEffect
        Settings.clipboardSeenAt = stamp
        val text = cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString() ?: return@LaunchedEffect
        val n = try {
            Engine.obj("review", jsonOf("text" to text)).optInt("proxies")
        } catch (e: EngineError) {
            0
        }
        if (n > 0) clip = text to n
    }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 30.dp)) {
        item("intro") {
            Column {
                Txt("See which of your proxies work.", type(15.sp, FontWeight.Medium, C.ink2, lineHeight = 22.sp))
                Spacer(Modifier.height(16.dp))
                ClipCard(clip, onCheck = { start(it) }, onPaste = {
                    val cm = context.getSystemService(ClipboardManager::class.java)
                    val text = cm?.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()
                    if (text.isNullOrBlank()) AppState.toast("Nothing to paste: copy your proxies first") else start(text)
                })
                JudgeRow(judge) { nav.open(SheetKind.Judge) }
                Txt("Or add them another way", type(13.sp, FontWeight.Bold, C.ink3), modifier = Modifier.padding(start = 4.dp, top = 18.dp, bottom = 8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Way(I.file, "File", Modifier.weight(1f)) { file.launch("text/*") }
                    Way(I.qr, "Scan", Modifier.weight(1f)) { nav.scan { got -> start(got) } }
                    Way(I.type, "Type", Modifier.weight(1f)) { nav.open(SheetKind.CheckType) }
                }
            }
        }
        if (library.groups.isNotEmpty() || library.proxies.isNotEmpty()) {
            item("mine") { Txt("Your proxies", type(13.sp, FontWeight.Bold, C.ink3), modifier = Modifier.padding(start = 4.dp, top = 22.dp, bottom = 4.dp)) }
            items(library.groups.take(6), key = { "g-" + it.id }) { g ->
                val s = Shown.of(g)
                CheckRow(s.cc, s.name, s.sub) { start(group = g.id) }
            }
            if (library.proxies.isNotEmpty()) {
                item("singles") {
                    CheckRow(null, "Your single proxies", "${library.proxies.size} saved") { start(saved = true) }
                }
            }
        }
        if (recent.isNotEmpty()) {
            item("recent") { Txt("Recent checks", type(13.sp, FontWeight.Bold, C.ink3), modifier = Modifier.padding(start = 4.dp, top = 22.dp, bottom = 4.dp)) }
            items(recent.take(6), key = { "r-" + it.id }) { s -> RecentRow(s) { start(again = s.id) } }
        }
    }
}

@Composable
private fun ClipCard(clip: Pair<String, Int>?, onCheck: (String) -> Unit, onPaste: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(cut(26.dp, 9.dp))
            .background(C.blue)
            .padding(20.dp),
    ) {
        Ic(I.paste, 26.dp, C.white)
        Spacer(Modifier.height(12.dp))
        if (clip != null) {
            Txt(if (clip.second == 1) "1 proxy on your clipboard" else "${clip.second} proxies on your clipboard", type(22.sp, FontWeight.Bold, C.white, spacing = (-0.015).em, numbers = true, lineHeight = 26.sp))
            Spacer(Modifier.height(4.dp))
            val first = clip.first.lineSequence().firstOrNull { it.isNotBlank() }?.let(::masked) ?: ""
            Txt(if (clip.second > 1) "$first and ${clip.second - 1} more" else first, type(14.sp, FontWeight.SemiBold, C.onBlue2, numbers = true), maxLines = 1)
            Spacer(Modifier.height(16.dp))
            Btn("Check them", { onCheck(clip.first) }, Modifier.fillMaxWidth(), kind = BtnKind.White)
        } else {
            Txt("Paste your proxies", type(22.sp, FontWeight.Bold, C.white, spacing = (-0.015).em))
            Spacer(Modifier.height(4.dp))
            Txt("Any format, one per line, as many as you like", type(14.sp, FontWeight.SemiBold, C.onBlue2))
            Spacer(Modifier.height(16.dp))
            Btn("Paste", onPaste, Modifier.fillMaxWidth(), kind = BtnKind.White)
        }
    }
}

/** The judge, the checker's one choice: who answers each proxy with what it saw. */
@Composable
private fun JudgeRow(judge: JudgeSet, onClick: () -> Unit) {
    val shape = cut(16.dp, 6.dp)
    Row(
        Modifier
            .padding(top = 10.dp)
            .fillMaxWidth()
            .height(50.dp)
            .pressable(onClick, scale = 0.985f)
            .clip(shape)
            .border(1.dp, C.line, shape)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Ic(I.shield, 20.dp, C.ink2)
        Row(Modifier.weight(1f)) {
            Txt("Judge ", type(14.5.sp, FontWeight.SemiBold, C.ink2), maxLines = 1)
            Txt(judge.name, type(14.5.sp, FontWeight.Bold, C.ink), maxLines = 1)
        }
        Ic(I.down, 18.dp, C.ink2)
    }
}

@Composable
private fun CheckRow(cc: String?, name: String, sub: String, onCheck: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (cc != null) Flag(cc, 30.dp, 22.dp) else Box(Modifier.size(30.dp, 22.dp), contentAlignment = Alignment.Center) { Ic(I.places, 22.dp, C.ink3) }
        Column(Modifier.weight(1f)) {
            Txt(name, type(16.sp, FontWeight.Bold, spacing = (-0.01).em), maxLines = 1)
            Txt(sub, type(13.sp, FontWeight.Medium, C.ink2), maxLines = 1)
        }
        TextBtn("Check", onCheck)
    }
}

@Composable
private fun RecentRow(s: Summary, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).pressable(onClick, scale = 0.99f).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.size(30.dp, 22.dp), contentAlignment = Alignment.Center) { Ic(I.checker, 22.dp, C.ink2) }
        Column(Modifier.weight(1f)) {
            Txt("${s.total} proxies", type(15.5.sp, FontWeight.Bold), maxLines = 1)
            Txt(whenWas(s.at), type(13.sp, FontWeight.Medium, C.ink2), maxLines = 1)
        }
        Column(horizontalAlignment = Alignment.End) {
            Row(Modifier.width(72.dp).height(6.dp).clip(RoundedCornerShape(3.dp)).background(C.s3)) {
                val total = s.total.coerceAtLeast(1).toFloat()
                if (s.working > 0) Box(Modifier.weight(s.working / total).height(6.dp).background(OK))
                if (s.slow > 0) Box(Modifier.weight(s.slow / total).height(6.dp).background(WARN))
                if (s.bad > 0) Box(Modifier.weight(s.bad / total).height(6.dp).background(BAD))
                val rest = (total - s.working - s.slow - s.bad) / total
                if (rest > 0.001f) Spacer(Modifier.weight(rest))
            }
            Spacer(Modifier.height(6.dp))
            // Working as the run counted it: the fast ones and the slow ones (works()).
            Txt("${s.working + s.slow} working", type(12.5.sp, FontWeight.SemiBold, C.ink2, numbers = true))
        }
    }
}

private fun whenWas(at: Long): String {
    val ago = (System.currentTimeMillis() - at) / 60000
    return when {
        ago < 1 -> "Just now"
        ago < 60 -> "$ago min ago"
        ago < 24 * 60 -> "${ago / 60} h ago"
        else -> "${ago / (24 * 60)} days ago"
    }
}

@Composable
private fun FlipRun(cards: List<Card>, stage: Stage, onOpen: (Card) -> Unit) {
    val running = stage == Stage.Running
    val landed = cards.count { it.answer != null }
    val working = workingOf(cards)
    val ranks = working.withIndex().associate { (n, c) -> c.i to n + 1 }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val gap = 6.dp
        val cardW: Dp = ((maxWidth - 40.dp - gap * 5) / 6)
        val cardH: Dp = cardW * (64f / 57f)
        LazyVerticalGrid(
            GridCells.Fixed(6),
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 40.dp),
            horizontalArrangement = Arrangement.spacedBy(gap),
            verticalArrangement = Arrangement.spacedBy(gap),
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), verticalAlignment = Alignment.Bottom) {
                    Column(Modifier.weight(1f)) {
                        Txt("${working.size}", type(52.sp, FontWeight.ExtraBold, OK, spacing = (-1.5).sp, numbers = true, lineHeight = 54.sp))
                        Spacer(Modifier.height(4.dp))
                        Txt(if (running) "working so far" else "working", type(13.sp, FontWeight.SemiBold, C.ink2))
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Txt("$landed/${cards.size}", type(22.sp, FontWeight.Bold, numbers = true))
                        Spacer(Modifier.height(4.dp))
                        Txt("turned over", type(13.sp, FontWeight.SemiBold, C.ink2))
                    }
                }
            }
            items(cards.size, key = { cards[it].i }) { n ->
                val c = cards[n]
                FlipCard(c, if (running) null else ranks[c.i], cardW, cardH) { onOpen(c) }
            }
        }
    }
}

@Composable
private fun FlipCard(c: Card, rank: Int?, w: Dp, h: Dp, onClick: () -> Unit) {
    val a = c.answer
    val turn = remember(c.i) { Animatable(if (a != null) 180f else 0f) }
    LaunchedEffect(a != null) {
        if (a != null && turn.value < 180f) turn.animateTo(180f, tween(520, easing = TURN))
    }
    val shape = cut(12.dp, 5.dp)
    Box(
        Modifier
            .size(w, h)
            .pressable(onClick, scale = 0.94f)
            .graphicsLayer {
                rotationY = turn.value
                cameraDistance = 12f * density
            },
    ) {
        val up = turn.value > 90f && a != null
        if (!up) {
            Column(
                Modifier.fillMaxSize().clip(shape).background(C.s2).border(1.dp, C.line, shape),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                if (c.cc != null) Flag(c.cc, 20.dp, 15.dp, line = false) else Box(Modifier.size(20.dp, 15.dp).clip(RoundedCornerShape(3.dp)).background(C.s3))
                Spacer(Modifier.height(3.dp))
                Txt(tail(c.address), type(11.sp, FontWeight.Bold, C.ink3, numbers = true), maxLines = 1)
            }
        } else {
            // Drawn mirrored back so its words read the right way round once turned.
            val (big, small) = faceWords(a!!)
            Box(Modifier.fillMaxSize().graphicsLayer { rotationY = 180f }.clip(shape).background(colourOf(a.face))) {
                if (rank != null) Txt("$rank", type(9.5.sp, FontWeight.ExtraBold, inkOf(a.face)), modifier = Modifier.padding(start = 6.dp, top = 4.dp))
                Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Txt(big, type(15.sp, FontWeight.ExtraBold, inkOf(a.face), numbers = true, lineHeight = 15.sp), maxLines = 1)
                    Spacer(Modifier.height(3.dp))
                    Txt(small, type(9.5.sp, FontWeight.Bold, inkOf(a.face)), maxLines = 1)
                }
            }
        }
    }
}

/** ".41": the end of an address, what a card shows face down. */
private fun tail(address: String): String {
    val host = address.substringBeforeLast(':')
    return if (host.count { it == '.' } == 3 && host.all { it.isDigit() || it == '.' }) "." + host.substringAfterLast('.') else host.take(6)
}

/** Where a checked proxy comes out, in words: "Frankfurt, Germany". */
private fun whereOf(a: Answer): String? = listOfNotNull(a.city, a.country ?: countryName(a.cc)).joinToString(", ").ifEmpty { null }

/** Use a checked proxy on this phone: saved into My proxies, then connected; its row here says so. */
private suspend fun useOnPhone(nav: Nav, c: Card) {
    val line = CheckerState.lines(listOf(c)).firstOrNull() ?: return
    try {
        val o = Engine.obj("add", jsonOf("text" to line, "asGroup" to false))
        o.optJSONObject("library")?.let(AppState::setLibrary)
        val place = PlaceRef.of(o.optJSONObject("added")?.optJSONObject("place")) ?: return
        nav.askVpn { AppState.connect(place) }
    } catch (e: EngineError) {
        AppState.toast(e.message ?: "Could not use it")
    }
}

/** The run is over: how many work, what to do with them, and the proxies themselves. */
@OptIn(FlowPreview::class)
@Composable
private fun DoneList(nav: Nav, cards: List<Card>) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val judge by Settings.judge.collectAsState()
    val library by AppState.library.collectAsState()
    val conn by AppState.conn.collectAsState()
    val scores by FraudScores.scores.collectAsState()
    val checkers by Settings.checkers.collectAsState()
    val names by Settings.freeNames.collectAsState()
    val headline = remember(checkers) { FraudScores.headline() }
    var show by rememberSaveable { mutableStateOf(Show.Working) }
    val working = workingOf(cards)
    val all = ordered(cards)
    val rows = if (show == Show.Working) working else all
    val list = rememberLazyListState()
    // The fraud score of the rows on screen.
    val byIndex = remember(rows) { rows.associateBy { it.i } }
    LaunchedEffect(list, headline, byIndex) {
        val id = headline ?: return@LaunchedEffect
        snapshotFlow { list.layoutInfo.visibleItemsInfo.mapNotNull { it.key as? Int } }
            .distinctUntilChanged()
            .debounce(150)
            .collect { keys -> FraudScores.want(id, keys.mapNotNull { byIndex[it]?.answer?.exitIp }) }
    }
    val fastest = working.mapNotNull { it.answer?.ms }.minOrNull()

    LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(start = 8.dp, end = 8.dp, top = 2.dp, bottom = 40.dp)) {
        item("sum") {
            Row(Modifier.padding(start = 12.dp, end = 12.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Txt("${working.size}", type(46.sp, FontWeight.ExtraBold, OK, spacing = (-0.03).em, numbers = true, lineHeight = 48.sp))
                Column {
                    Txt("working of ${cards.size}", type(14.sp, FontWeight.SemiBold, C.ink2, numbers = true))
                    Txt(listOfNotNull(fastest?.let { "fastest ${speedText(it)}" }, "judge ${judge.name}").joinToString(" · "), type(14.sp, FontWeight.SemiBold, C.ink2, numbers = true), maxLines = 1)
                }
            }
        }
        item("actions") {
            Row(Modifier.padding(start = 12.dp, end = 12.dp, top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LineBtn("Copy working", {
                    scope.launch {
                        val lines = CheckerState.lines(working)
                        if (lines.isNotEmpty()) {
                            copy(context, lines.joinToString("\n"))
                            AppState.toast("${lines.size} working proxies copied, as you pasted them")
                        }
                    }
                }, icon = I.copy, small = true, enabled = working.isNotEmpty())
                LineBtn("Save", {
                    scope.launch {
                        val lines = CheckerState.lines(working)
                        if (lines.isEmpty()) return@launch
                        try {
                            val o = Engine.obj("add", jsonOf("text" to lines.joinToString("\n"), "asGroup" to (lines.size > 1)))
                            o.optJSONObject("library")?.let(AppState::setLibrary)
                            AppState.toast(if (lines.size > 1) "${lines.size} saved in My proxies, as a group" else "Saved in My proxies")
                        } catch (e: EngineError) {
                            AppState.toast(e.message ?: "They were not saved")
                        }
                    }
                }, icon = I.save, small = true, enabled = working.isNotEmpty())
                LineBtn("Again", {
                    scope.launch {
                        val lines = CheckerState.lines(cards)
                        if (lines.isNotEmpty()) CheckerState.start(text = lines.joinToString("\n"))?.let(AppState::toast)
                    }
                }, icon = I.again, small = true)
            }
        }
        item("show") {
            Segments(
                show,
                listOf(Show.Working to "Working ${working.size}", Show.All to "All ${cards.size}"),
                { show = it },
                Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 8.dp),
            )
        }
        if (rows.isEmpty()) {
            item("none") {
                Txt(
                    "None of them works from this phone. All ${cards.size} shows why each one failed.",
                    type(15.sp, FontWeight.Medium, C.ink2, lineHeight = 21.sp),
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 24.dp),
                )
            }
        }
        items(rows, key = { it.i }) { c ->
            val a = c.answer
            val usable = works(c)
            // The proxy in use says so, whether it is a saved one or a free one, under its name.
            val saved = library.proxies.find { it.address == c.address }
            val st = saved?.let { conn.of("p:${it.id}") }?.takeIf { it !is RowState.Idle } ?: conn.of("x:${c.address}")
            val where = a?.let(::whereOf)
            val sub = when {
                a == null -> "Not checked"
                a.face == Face.Slow -> a.says
                usable -> listOfNotNull(where, a.way?.uppercase()).joinToString(" · ").ifEmpty { a.says }
                a.face == Face.Dead -> a.error?.replaceFirstChar { it.uppercase() } ?: "No answer"
                else -> a.says
            }
            ProxyRow(
                cc = a?.cc?.lowercase() ?: c.cc,
                title = saved?.name?.takeIf { it.isNotBlank() } ?: names[c.address]?.takeIf { it.isNotBlank() } ?: c.address,
                sub = sub,
                state = st,
                ms = if (usable) a?.ms else null,
                score = if (usable) headline?.let { id -> a?.exitIp?.let { scores[FraudScores.key(id, it)]?.score } } else null,
                dim = !usable,
                subTone = if (!usable && a?.face != Face.Dead) C.bad else if (!usable) C.ink3 else null,
                onClick = {
                    nav.card = c.i
                    nav.open(SheetKind.Card)
                },
                onMore = if (usable) {
                    {
                        // The one being connected or in use: its power button turns it off.
                        val key = saved?.let { "p:${it.id}" } ?: "x:${c.address}"
                        if (st is RowState.Busy || (conn.running && conn.place == key && conn.phase == Phase.On)) {
                            AppState.disconnect()
                        } else {
                            scope.launch { useOnPhone(nav, c) }
                        }
                    }
                } else {
                    null
                },
                modifier = Modifier.animateItem(fadeInSpec = null, placementSpec = tween(520, easing = Glide), fadeOutSpec = null),
            )
        }
    }
}

/** A checked proxy, opened: what it is, why it fails, use it or copy it. */
@Composable
fun CardSheet(nav: Nav) {
    val run by CheckerState.run.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val c = run?.cards?.firstOrNull { it.i == nav.card } ?: return
    val a = c.answer
    val tone = when (a?.face) {
        null -> C.ink2
        Face.Good -> C.ok
        Face.Slow -> C.warn
        Face.Dead -> C.ink3
        else -> C.bad
    }
    val short = when (a?.face) {
        null -> "Checking"
        Face.Good -> "Working · ${a.ms} ms"
        else -> a.says
    }
    val long = when (a?.face) {
        null, Face.Good -> null
        Face.Dead -> a.error?.replaceFirstChar { it.uppercase() } ?: "No answer within 8 seconds: it is off, or it refuses you."
        else -> a.why ?: a.says
    }
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Flag(a?.cc ?: c.cc, 34.dp, 25.dp)
        Column {
            Txt(c.address, type(18.sp, FontWeight.Bold, numbers = true), maxLines = 1)
            Txt(short, type(13.sp, FontWeight.SemiBold), color = tone, maxLines = 1)
        }
    }
    Column(Modifier.padding(start = 20.dp, end = 20.dp, bottom = 24.dp)) {
        if (long != null) {
            Txt(long, type(14.sp, FontWeight.SemiBold, C.ink2, lineHeight = 20.sp))
            Spacer(Modifier.height(12.dp))
        }
        if (a != null) {
            val facts = listOf(
                "Protocol" to (a.way?.uppercase() ?: a.protocols.joinToString(", ").uppercase().ifEmpty { "None" }),
                "Exits in" to (whereOf(a) ?: "Not known"),
                "Network" to when (a.datacenter) {
                    true -> "Data center"
                    false -> "Home or mobile"
                    null -> "Not known"
                },
                "Hides you" to when {
                    "not_hidden" in a.notes -> "No, sites see you"
                    "tells_http_sites" in a.notes -> "Tells http sites"
                    a.alive -> "Yes"
                    else -> "Not known"
                },
                "Exit address" to (a.exitIp ?: "None"),
                "Answer" to (if (a.alive) "${a.ms ?: 0} ms" else "None"),
            )
            for (row in facts.chunked(2)) {
                Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    for ((k, v) in row) {
                        Column(Modifier.weight(1f)) {
                            Txt(k, type(12.sp, FontWeight.SemiBold, C.ink3))
                            Spacer(Modifier.height(2.dp))
                            Txt(v, type(14.sp, FontWeight.Bold, numbers = true, lineHeight = 19.sp), maxLines = 2)
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val usable = works(c)
            if (usable) {
                Btn("Use on this phone", {
                    nav.sheet = null
                    scope.launch { useOnPhone(nav, c) }
                }, Modifier.weight(1f))
            }
            LineBtn("Copy", {
                scope.launch {
                    val line = CheckerState.lines(listOf(c)).firstOrNull() ?: c.address
                    copy(context, line)
                    AppState.toast("${c.address} copied")
                }
            }, if (usable) Modifier else Modifier.weight(1f), icon = I.copy, height = 56.dp)
        }
    }
}

/** Type proxies in for the checker: one per line, any format, a keyboard that corrects nothing. */
@Composable
fun CheckTypeSheet(nav: Nav) {
    var text by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Txt("Type your proxies", type(22.sp, FontWeight.Bold, spacing = (-0.015).em))
        Area(text, { text = it }, "One per line, any format", autoFocus = true)
        Btn("Check them", {
            nav.sheet = null
            scope.launch { CheckerState.start(text = text)?.let(AppState::toast) }
        }, Modifier.fillMaxWidth(), enabled = text.isNotBlank())
    }
}

/** The judge: the address every proxy is asked to open. It answers with what it saw. */
@Composable
fun ColumnScope.JudgeSheet(nav: Nav) {
    val judge by Settings.judge.collectAsState()
    var url by remember { mutableStateOf(judge.url) }
    SheetHead("Judge")
    Txt(
        "The address every proxy is asked to open. It answers with what it saw.",
        type(15.sp, FontWeight.Medium, C.ink2, lineHeight = 22.sp),
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp),
    )
    Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 24.dp)) {
        for (k in JudgeKind.entries) {
            SheetRow(judge.kind == k, k.label, k.about) {
                Settings.setJudge(JudgeSet(k, url))
                if (k != JudgeKind.Own) nav.sheet = null
            }
        }
        if (judge.kind == JudgeKind.Own) {
            Field(
                url,
                { v ->
                    url = v
                    Settings.setJudge(JudgeSet(JudgeKind.Own, v.trim()))
                },
                placeholder = "http://your-judge.example/echo",
                modifier = Modifier.padding(top = 8.dp, start = 4.dp, end = 4.dp),
                height = 46.dp,
                surface = C.bg,
                plain = true,
            )
        }
    }
}
