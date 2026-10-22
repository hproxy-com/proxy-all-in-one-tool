package com.hproxy.app.ui.proxies

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.engine.Expiry
import com.hproxy.app.engine.FreeExit
import com.hproxy.app.engine.GroupItem
import com.hproxy.app.engine.PlaceRef
import com.hproxy.app.engine.ProxyItem
import com.hproxy.app.engine.countryName
import com.hproxy.app.engine.spelled
import com.hproxy.app.state.Answer
import com.hproxy.app.state.AppState
import com.hproxy.app.state.CheckerId
import com.hproxy.app.state.Conn
import com.hproxy.app.state.FraudAnswer
import com.hproxy.app.state.FraudScores
import com.hproxy.app.state.FreeList
import com.hproxy.app.state.JustAdded
import com.hproxy.app.state.Phase
import com.hproxy.app.state.RowState
import com.hproxy.app.state.Settings
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.SheetKind
import com.hproxy.app.ui.Shelf
import com.hproxy.app.ui.SortKey
import com.hproxy.app.ui.kit.Btn
import com.hproxy.app.ui.kit.Flag
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.IconBtn
import com.hproxy.app.ui.kit.Segments
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.kit.slideWith
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.Glide
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * The proxies, shaped like the big VPN apps' list of countries (the
 * fastest one first, then every country, each opening into its servers, a power button on each).
 * Ours: My proxies | Free; on Free, the fastest free proxy, then every country with how many proxies
 * it has and how fast the fastest is, each opening into its proxies. A row is the proxy itself (or
 * the name it was given), where it is, its speed and fraud score: pressing the row shows everything
 * about it (2026-10-12); its power button connects exactly that one, and Home shows it happen. Adding sits
 * bottom right, where the thumb is.
 */
@Composable
fun ProxiesTab(nav: Nav) {
    val library by AppState.library.collectAsState()
    val added by JustAdded.ids.collectAsState()
    LaunchedEffect(Unit) { FreeList.load() }
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    val freeState = rememberLazyListState()
    val mineState = rememberLazyListState()

    Box(Modifier.fillMaxSize().background(C.bg)) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.statusBarsPadding().padding(start = 20.dp, end = 8.dp, top = 6.dp).fillMaxWidth().height(48.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Txt("Proxies", type(30.sp, FontWeight.Bold, spacing = (-0.025).em), modifier = Modifier.weight(1f))
                IconBtn(
                    if (searching) I.close else I.search,
                    {
                        searching = !searching
                        if (!searching) query = ""
                    },
                    description = if (searching) "Close the search" else "Search",
                    tint = C.ink,
                )
            }
            Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 4.dp)) {
                Segments(nav.shelf, listOf(Shelf.Mine to "My proxies", Shelf.Free to "Free"), { nav.showShelf(it) })
                AnimatedVisibility(
                    searching,
                    enter = expandVertically(tween(320, easing = Glide), expandFrom = Alignment.Top),
                    exit = shrinkVertically(tween(260, easing = Glide), shrinkTowards = Alignment.Top),
                ) {
                    Field(
                        query,
                        { query = it },
                        placeholder = if (nav.shelf == Shelf.Free) "An IP, a city, a country" else "Your proxies",
                        modifier = Modifier.padding(top = 10.dp),
                        lead = I.search,
                        plain = true,
                        autoFocus = true,
                    )
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth().slideWith(nav.shelf, listOf(Shelf.Mine, Shelf.Free))) {
                if (nav.shelf == Shelf.Free) FreeShelf(nav, query, freeState) else MineShelf(nav, query, mineState)
            }
        }
        if (!(nav.shelf == Shelf.Mine && library.empty && added.isEmpty())) {
            AddButton(Modifier.align(Alignment.BottomEnd).padding(16.dp)) { nav.open(SheetKind.Add) }
        }
    }
}

/** Where a free proxy is, in a word: its city, else its country. */
private fun short(e: FreeExit): String = e.city ?: countryName(e.cc) ?: "Somewhere"

/** Every word of the search somewhere in what the row says. */
internal fun matches(query: String, vararg hay: String?): Boolean {
    val words = query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return true
    val all = hay.filterNotNull().joinToString(" ").lowercase()
    return words.all { it in all }
}

/** The free list's rows in the chosen order; the ones without the answer asked for go last. */
private fun ordered(rows: List<FreeExit>, sort: SortKey, score: (FreeExit) -> Int?): List<FreeExit> = when (sort) {
    SortKey.Fast -> rows.sortedBy { it.ms ?: Int.MAX_VALUE }
    SortKey.Fraud -> rows.sortedWith(compareBy<FreeExit>({ score(it) ?: Int.MAX_VALUE }, { it.ms ?: Int.MAX_VALUE }))
    SortKey.Uptime -> rows.sortedWith(compareBy<FreeExit>({ -(it.uptime ?: -1.0) }, { it.ms ?: Int.MAX_VALUE }))
    SortKey.Recent -> rows.sortedWith(compareBy<FreeExit>({ -(it.verifiedAt ?: 0L) }, { it.ms ?: Int.MAX_VALUE }))
}

/**
 * A proxy's power button: exactly that one, connected, right where you are: its row says it
 * connects and then that it is in use (2026-10-12: no jump to another tab on every connect; only
 * the H in the nav goes to Home). Pressed on the one in
 * use or being connected, it turns it off.
 */
internal fun go(nav: Nav, ref: PlaceRef, conn: Conn, member: Int? = null) {
    val state = conn.of(ref.key, member)
    val inUse = conn.running && conn.place == ref.key && (member == null || conn.member == member) && conn.phase == Phase.On
    if (state is RowState.Busy || inUse) {
        AppState.disconnect()
        return
    }
    nav.askVpn { AppState.connect(ref, member) }
}

@OptIn(FlowPreview::class)
@Composable
private fun FreeShelf(nav: Nav, query: String, state: LazyListState) {
    val list by FreeList.list.collectAsState()
    val error by FreeList.error.collectAsState()
    val names by Settings.freeNames.collectAsState()
    val scores by FraudScores.scores.collectAsState()
    val checkers by Settings.checkers.collectAsState()
    val conn by AppState.conn.collectAsState()
    val headline = remember(checkers) { FraudScores.headline() }
    val sort = nav.sort
    // The countries open, kept while the app lives ("de,us").
    var openList by rememberSaveable { mutableStateOf("") }
    val open = openList.split(',').filter { it.isNotEmpty() }.toSet()
    fun toggle(cc: String) {
        openList = (if (cc in open) open - cc else open + cc).joinToString(",")
    }
    fun scoreOf(e: FreeExit): Int? = headline?.let { scores[FraudScores.key(it, e.host)]?.score }
    val all = list.orEmpty()
    val searching = query.isNotBlank()
    val found = remember(all, query, names, sort, if (sort == SortKey.Fraud) scores else null, headline) {
        if (!searching) {
            emptyList()
        } else {
            ordered(
                all.filter { e ->
                    matches(query, names[e.addr], e.addr, e.city, e.region, countryName(e.cc), e.proto, e.kind.label.takeIf { e.datacenter != null }, e.network)
                },
                sort,
                ::scoreOf,
            )
        }
    }
    val countries = remember(all) {
        all.filter { it.cc != null }.groupBy { it.cc!! }.toList().sortedBy { (cc, _) -> countryName(cc) ?: cc }
    }
    // The same one Home offers: fast, and among those that tend to answer.
    val fastest = remember(all) { FreeList.fastest() }
    val byAddr = remember(all) { all.associateBy { it.addr } }

    // The fraud score of the rows on screen (a key with a quota is never spent on the whole list),
    // of every row of the open countries when they are ordered by it.
    LaunchedEffect(state, headline, byAddr, sort, openList) {
        val id = headline ?: return@LaunchedEffect
        if (sort == SortKey.Fraud) FraudScores.want(id, all.filter { it.cc in open }.map { it.host })
        snapshotFlow { state.layoutInfo.visibleItemsInfo.mapNotNull { it.key as? String } }
            .distinctUntilChanged()
            .debounce(150)
            .collect { keys -> FraudScores.want(id, keys.mapNotNull { byAddr[it]?.host }) }
    }

    @Composable
    fun Proxy(e: FreeExit, modifier: Modifier) {
        val ref = e.ref
        val named = names[e.addr]?.takeIf { it.isNotBlank() }
        ProxyRow(
            cc = e.cc,
            title = named ?: e.addr,
            sub = if (named != null) "${e.addr} · ${short(e)}" else "${short(e)} · ${e.proto}",
            state = conn.of(ref.key),
            ms = e.ms,
            score = scoreOf(e),
            onClick = { nav.openProxy(ref) },
            onMore = { go(nav, ref, conn) },
            modifier = modifier,
        )
    }

    LazyColumn(Modifier.fillMaxSize(), state = state, contentPadding = PaddingValues(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 92.dp)) {
        val l = list
        when {
            l == null && error != null -> item("error") { Note(error ?: "", action = "Try again") { FreeList.load(force = true) } }
            l == null -> item("loading") { Note("Finding the free proxies that answer") }
            searching -> {
                item("found") { ListHead("${found.size} found") }
                items(found, key = { it.addr }) { e -> Proxy(e, Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null)) }
                if (found.isEmpty()) item("none") { Note("Nothing matches. Try another word.") }
            }
            else -> {
                if (fastest != null) item("fastest") { Fastest(fastest, conn.of(fastest.ref.key)) { go(nav, fastest.ref, conn) } }
                item("head") { CountriesHead(countries.size, all.size, sort) { nav.open(SheetKind.Sort) } }
                for ((cc, rows) in countries) {
                    // A country whose proxy is in use (or being connected) says so while it is closed.
                    val inside = rows.firstNotNullOfOrNull { e -> conn.of(e.ref.key).takeIf { it !is RowState.Idle } } ?: RowState.Idle
                    item("c-$cc") { Country(cc, rows, cc in open, inside) { toggle(cc) } }
                    if (cc in open) {
                        items(ordered(rows, sort, ::scoreOf), key = { it.addr }) { e ->
                            Proxy(e, Modifier.padding(start = 10.dp).animateItem(fadeInSpec = null, fadeOutSpec = null))
                        }
                    }
                }
            }
        }
    }
}

/**
 * The fastest free proxy right now: one press connects it. It is a
 * proxy row like the others, so it says when it is the one being connected or in use.
 */
@Composable
private fun Fastest(e: FreeExit, state: RowState, onClick: () -> Unit) {
    ProxyRow(
        cc = null,
        title = "Fastest free proxy",
        sub = listOfNotNull(short(e), e.ms?.let(::speedText)).joinToString(" · "),
        state = state,
        ms = null,
        score = null,
        onClick = onClick,
        onMore = onClick,
        lead = { Ic(I.bolt, 24.dp, C.blueInk) },
    )
}

/** "All countries (63)", and the order the proxies of a country are shown in. */
@Composable
private fun CountriesHead(countries: Int, proxies: Int, sort: SortKey, onSort: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 12.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Txt("$countries countries", type(13.sp, FontWeight.Bold, C.ink3, numbers = true), modifier = Modifier.weight(1f), maxLines = 1)
        Row(
            Modifier.pressable(onSort, scale = 0.96f).padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Ic(I.sort, 16.dp, C.ink2)
            Txt(sort.short, type(13.sp, FontWeight.Bold, C.ink2), maxLines = 1)
        }
    }
}

/**
 * A country: its flag, its name, how many proxies; it opens into them. Closed, it carries the state
 * of its proxy in use (the big VPN apps mark the connected country the same way), so the connection
 * is never hidden inside a closed country.
 */
@Composable
private fun Country(cc: String, rows: List<FreeExit>, open: Boolean, inside: RowState, onClick: () -> Unit) {
    val turn by animateFloatAsState(if (open) 180f else 0f, tween(320, easing = Glide), label = "countryTurn")
    val shown = if (open) RowState.Idle else inside
    val bg by animateColorAsState(if (open || shown !is RowState.Idle) C.s1 else C.bg, tween(220), label = "countryBg")
    val words = stateWords(shown)
    Box(Modifier.fillMaxWidth().heightIn(min = 64.dp).clip(cut(16.dp, 6.dp)).background(bg)) {
        UseMark(shown, Modifier.matchParentSize())
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
                .pressable(onClick, scale = 0.99f)
                .padding(start = 12.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Flag(cc, 30.dp, 22.dp)
            Column(Modifier.weight(1f)) {
                Txt(
                    countryName(cc) ?: cc.uppercase(),
                    type(16.sp, FontWeight.Bold, spacing = (-0.01).em),
                    color = if (shown is RowState.On) C.blueInk else C.ink,
                    maxLines = 1,
                )
                Txt(
                    words ?: "${rows.size} ${if (rows.size == 1) "proxy" else "proxies"}",
                    type(13.sp, if (words != null) FontWeight.SemiBold else FontWeight.Medium, numbers = true),
                    color = when (shown) {
                        is RowState.Bad -> C.bad
                        RowState.Idle -> C.ink2
                        else -> C.blueInk
                    },
                    maxLines = 1,
                )
            }
            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                Ic(I.down, 20.dp, C.ink3, modifier = Modifier.graphicsLayer { rotationZ = turn })
            }
        }
    }
}

/** Words for a saved proxy's row: the name it was given or the proxy itself, where it is, how fast. */
internal data class SavedWords(val title: String, val sub: String, val cc: String?, val ms: Int?, val exitIp: String?, val dead: Boolean)

internal fun savedWords(p: ProxyItem, a: Answer?): SavedWords {
    val about = p.about
    val last = p.last
    val name = p.name?.takeIf { it.isNotBlank() }
    val title = name ?: about?.session?.let { "Session $it" } ?: p.address
    val cc = (a?.cc ?: about?.country ?: last?.cc)?.lowercase()?.takeIf { it.length == 2 }
    val where = a?.city?.let { listOfNotNull(it, a?.country).joinToString(", ") }
        ?: listOfNotNull(about?.city, about?.region).firstOrNull()?.let(::spelled)
        ?: last?.place
        ?: countryName(cc)
    val proto = p.scheme?.uppercase() ?: a?.way?.uppercase()
    val dead = if (a != null) !a.alive else last?.ok == false
    val sub = when {
        dead -> listOfNotNull("Not answering", where).joinToString(" · ")
        name != null || about?.session != null -> listOfNotNull(p.address.takeIf { it != title }, where).joinToString(" · ").ifEmpty { proto ?: "Your proxy" }
        else -> listOfNotNull(where, proto).joinToString(" · ").ifEmpty { "Not checked yet" }
    }
    val ms = if (dead) null else a?.ms ?: last?.latencyMs
    return SavedWords(title, sub, cc, ms, a?.exitIp ?: last?.exitIp, dead)
}

@OptIn(FlowPreview::class)
@Composable
private fun MineShelf(nav: Nav, query: String, state: LazyListState) {
    val library by AppState.library.collectAsState()
    val added by JustAdded.ids.collectAsState()
    val checking by JustAdded.checking.collectAsState()
    val answers by JustAdded.answers.collectAsState()
    val scores by FraudScores.scores.collectAsState()
    val checkers by Settings.checkers.collectAsState()
    val conn by AppState.conn.collectAsState()
    val headline = remember(checkers) { FraudScores.headline() }

    val justAdded = added.mapNotNull { id -> library.proxies.find { it.id == id } }
    val words = remember(library, answers) { library.proxies.associate { it.id to savedWords(it, answers[it.id]) } }
    fun hit(p: ProxyItem): Boolean = words[p.id]?.let { w -> matches(query, w.title, w.sub, p.address, countryName(w.cc), p.note) } ?: true
    val fresh = justAdded.filter(::hit)
    val groups = library.groups.filter { g -> matches(query, g.name, countryName(g.shared.country?.lowercase()), g.shared.city, g.shared.kind?.label, g.note) }
    val singles = library.proxies.filter { it.id !in added && hit(it) }
    // Plans ending within three days, and ended ones, counted over the list (a group is one plan).
    val days = remember(library) { (library.proxies.map { it.expires } + library.groups.map { it.expires }).mapNotNull { Expiry.daysLeft(it) } }
    val soon = days.count { it in 0..Expiry.SOON }
    val ended = days.count { it < 0 }

    // The fraud score of the saved proxies on screen, from where each came out at its last check
    // (a key with a quota is never spent on the whole list).
    LaunchedEffect(state, headline, words) {
        val id = headline ?: return@LaunchedEffect
        snapshotFlow { state.layoutInfo.visibleItemsInfo.mapNotNull { (it.key as? String)?.substringAfter('-') } }
            .distinctUntilChanged()
            .debounce(150)
            .collect { ids -> FraudScores.want(id, ids.mapNotNull { words[it]?.exitIp }) }
    }
    fun scoreOf(w: SavedWords?, id: CheckerId?): Int? = if (w?.exitIp == null || id == null) null else scores[FraudScores.key(id, w.exitIp)]?.score

    LazyColumn(Modifier.fillMaxSize(), state = state, contentPadding = PaddingValues(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 92.dp)) {
        if (library.empty && added.isEmpty()) {
            item("empty") { EmptyMine(nav) }
            return@LazyColumn
        }
        @Composable
        fun Saved(p: ProxyItem, modifier: Modifier) {
            val w = words[p.id] ?: savedWords(p, null)
            val ref = PlaceRef.Proxy(p.id)
            val st = conn.of(ref.key)
            ProxyRow(
                cc = w.cc,
                title = w.title,
                sub = listOfNotNull(w.sub, firstLine(p.note)).joinToString(" · "),
                state = st,
                ms = w.ms,
                score = scoreOf(w, headline),
                checking = p.id in checking,
                dim = w.dead && st is RowState.Idle,
                onClick = { nav.openProxy(ref) },
                onMore = { go(nav, ref, conn) },
                modifier = modifier,
                tag = Expiry.of(p.expires),
            )
        }
        if (soon > 0 || ended > 0) item("h-expiry") { ExpiryLine(soon, ended) }
        if (fresh.isNotEmpty()) {
            item("h-added") { ListHead("Just added") }
            items(fresh, key = { "a-" + it.id }) { p -> Saved(p, Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null)) }
        }
        if (groups.isNotEmpty()) {
            item("h-groups") { ListHead("Groups", modifier = Modifier.padding(top = if (fresh.isNotEmpty()) 14.dp else 0.dp)) }
            items(groups, key = { "g-" + it.id }) { g -> GroupRow(nav, g, conn, Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null)) }
        }
        if (singles.isNotEmpty()) {
            item("h-singles") {
                ListHead("Single proxies", modifier = Modifier.padding(top = if (fresh.isNotEmpty() || groups.isNotEmpty()) 14.dp else 0.dp))
            }
            items(singles, key = { "p-" + it.id }) { p -> Saved(p, Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null)) }
        }
        if (fresh.isEmpty() && groups.isEmpty() && singles.isEmpty()) item("none") { Note("Nothing matches. Try another word.") }
    }
}

/** A group: its sessions are inside. */
@Composable
private fun GroupRow(nav: Nav, g: GroupItem, conn: Conn, modifier: Modifier) {
    val st = conn.of("g:${g.id}")
    val count = if (g.sessions > 0) "${g.sessions} sessions" else "${g.size} proxies"
    val where = listOfNotNull(g.shared.city, g.shared.region).firstOrNull()?.let(::spelled) ?: countryName(g.shared.country?.lowercase())
    ProxyRow(
        cc = g.shared.country?.lowercase(),
        title = g.name,
        sub = listOfNotNull(g.shared.kind?.label, count, where, firstLine(g.note)).joinToString(" · "),
        state = st,
        ms = null,
        score = null,
        onClick = { nav.openGroup(g.id) },
        onMore = { nav.openGroup(g.id) },
        moreGlyph = I.right,
        moreTint = C.ink3,
        modifier = modifier,
        tag = Expiry.of(g.expires),
    )
}

/** A note's first line, for a row; the whole note is on the proxy's sheet. */
internal fun firstLine(note: String?): String? = note?.lineSequence()?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }

/** Over the list while plans end within three days or have ended: how many of each. */
@Composable
private fun ExpiryLine(soon: Int, ended: Int) {
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (soon > 0) {
            Txt("$soon ${if (soon == 1) "expires" else "expire"} within ${Expiry.SOON} days", type(13.sp, FontWeight.Bold, C.warn, numbers = true), maxLines = 1)
        }
        if (soon > 0 && ended > 0) Txt(" · ", type(13.sp, FontWeight.Bold, C.ink3), maxLines = 1)
        if (ended > 0) {
            Txt("$ended ${if (ended == 1) "has" else "have"} expired", type(13.sp, FontWeight.Bold, C.bad, numbers = true), maxLines = 1)
        }
    }
}

@Composable
private fun EmptyMine(nav: Nav) {
    Column(Modifier.padding(start = 12.dp, end = 12.dp, top = 34.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Txt("No proxies of your own yet", type(22.sp, FontWeight.Bold, spacing = (-0.015).em))
        // Someone who has proxies pastes them (2026-10-17: no "or try a free one" line); the free
        // ones stay on their own tab, right above.
        Txt("Paste them, scan a QR code or type one.", type(15.sp, FontWeight.Medium, C.ink2, lineHeight = 22.sp), modifier = Modifier.padding(bottom = 10.dp))
        Btn("Add proxies", { nav.open(SheetKind.Add) }, Modifier.fillMaxWidth(), icon = I.paste)
    }
}

/** A line of words where a list would be: loading, nothing found, or what went wrong. */
@Composable
internal fun Note(text: String, action: String? = null, onAction: () -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 30.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Txt(text, type(15.sp, FontWeight.Medium, C.ink2, lineHeight = 21.sp))
        if (action != null) TextBtn(action, onAction, Modifier.padding(top = 6.dp))
    }
}

/** "+ Add", white on the dark page, bottom right. */
@Composable
private fun AddButton(modifier: Modifier, onClick: () -> Unit) {
    Row(
        modifier
            .height(56.dp)
            .pressable(onClick, scale = 0.95f)
            .clip(cut(20.dp, 7.dp))
            .background(C.white)
            .padding(start = 18.dp, end = 22.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Ic(I.plus, 22.dp, C.blue)
        Txt("Add", type(16.sp, FontWeight.Bold), color = C.blue, maxLines = 1)
    }
}

/** A free proxy's fraud score from a checker, for the sheets. */
internal fun scoreFor(scores: Map<String, FraudAnswer>, id: CheckerId, ip: String?): FraudAnswer? = ip?.let { scores[FraudScores.key(id, it)] }
