package com.hproxy.app.ui.proxies

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.Kind
import com.hproxy.app.engine.PlaceRef
import com.hproxy.app.engine.countryName
import com.hproxy.app.engine.jsonOf
import com.hproxy.app.engine.spelled
import com.hproxy.app.state.AppState
import com.hproxy.app.state.CheckerId
import com.hproxy.app.state.FraudScores
import com.hproxy.app.state.FreeList
import com.hproxy.app.state.JustAdded
import com.hproxy.app.state.RowState
import com.hproxy.app.state.Settings
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.Page
import com.hproxy.app.ui.Tab
import com.hproxy.app.ui.kit.Bars
import com.hproxy.app.ui.kit.Btn
import com.hproxy.app.ui.kit.Flag
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.IconBtn
import com.hproxy.app.ui.kit.Line
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.kit.copy
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.type
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A proxy as its sheet shows it, free or saved. */
private data class Opened(
    val ref: PlaceRef,
    val cc: String?,
    val title: String,
    /** "Nuremberg, Bavaria, Germany". */
    val place: String,
    val addr: String,
    val proto: String?,
    val kind: String?,
    val ms: Int?,
    val network: String?,
    /** Where it comes out, when known: what the fraud checkers are asked about. */
    val exitIp: String?,
    val uptime: Double?,
    /** Saved on this phone: its id in the library. */
    val savedId: String?,
    /** The name it has now. */
    val name: String,
    val lastCheck: String?,
)

private fun openedOf(ref: PlaceRef): Opened? {
    val lib = AppState.library.value
    val health = AppState.health.value
    val conn = AppState.conn.value
    val inUse = conn.place == ref.key && conn.running
    return when (ref) {
        is PlaceRef.Proxy -> {
            val p = lib.proxies.find { it.id == ref.id } ?: return null
            val a = JustAdded.answers.value[p.id]
            val w = savedWords(p, a)
            val last = p.last
            val city = a?.city ?: listOfNotNull(p.about?.city, p.about?.region).firstOrNull()?.let(::spelled) ?: last?.place?.substringBefore(',')
            Opened(
                ref = ref,
                cc = w.cc,
                title = w.title,
                place = listOfNotNull(city, countryName(w.cc)).distinct().joinToString(", ").ifEmpty { "Not checked yet" },
                addr = p.address,
                proto = p.scheme?.uppercase() ?: a?.way?.uppercase(),
                kind = (p.about?.kind ?: when (a?.datacenter ?: last?.datacenter) {
                    true -> Kind.Datacenter
                    false -> Kind.Residential
                    null -> null
                })?.label,
                ms = w.ms,
                network = if (inUse) health?.asnOrg else null,
                exitIp = (if (inUse) health?.exitIp else null) ?: w.exitIp,
                uptime = null,
                savedId = p.id,
                name = p.name ?: "",
                lastCheck = last?.let { v -> (if (v.ok) "Answered" else "No answer") + " · " + ago(v.at) },
            )
        }
        is PlaceRef.Free -> {
            val addr = ref.exit ?: (if (inUse) AppState.status.value.freeExit else null) ?: return null
            val e = FreeList.find(addr)
            val named = Settings.freeNames.value[addr]?.takeIf { it.isNotBlank() }
            val cc = e?.cc ?: ref.country.lowercase().takeIf { it.length == 2 }
            Opened(
                ref = if (ref.exit == null) PlaceRef.Free(ref.country, addr, ref.socks5) else ref,
                cc = cc,
                title = named ?: addr,
                place = listOfNotNull(e?.city, e?.region?.takeIf { it != e?.city }, countryName(cc)).joinToString(", ").ifEmpty { "Somewhere" },
                addr = addr,
                proto = e?.proto ?: if (ref.socks5) "SOCKS5" else "HTTP",
                kind = e?.kind?.takeIf { it != Kind.Unknown }?.label,
                ms = e?.ms,
                network = e?.network ?: if (inUse) health?.asnOrg else null,
                exitIp = (if (inUse) health?.exitIp else null) ?: e?.host ?: addr.substringBeforeLast(':'),
                uptime = e?.uptime,
                savedId = null,
                name = named ?: "",
                lastCheck = null,
            )
        }
        is PlaceRef.Group -> null
    }
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
internal fun ago(at: Long): String {
    if (at <= 0) return "a while ago"
    val min = (System.currentTimeMillis() - at) / 60_000
    return when {
        min < 1 -> "just now"
        min < 60 -> "$min min ago"
        min < 24 * 60 -> "${min / 60} h ago"
        else -> "${min / (24 * 60)} days ago"
    }
}

/**
 * A proxy, opened: the proxy itself or the name you gave it, where it is, its name to change, what
 * it is, and what every fraud checker that is on says about where it comes out (several can be on).
 * At the foot: Save a free one into My proxies, and Connect.
 */
@Composable
fun ColumnScope.ProxySheet(nav: Nav) {
    val ref = nav.opened ?: return
    val library by AppState.library.collectAsState()
    @Suppress("UNUSED_VARIABLE") val free = FreeList.list.collectAsState().value
    @Suppress("UNUSED_VARIABLE") val names = Settings.freeNames.collectAsState().value
    @Suppress("UNUSED_VARIABLE") val answers = JustAdded.answers.collectAsState().value
    val checkers by Settings.checkers.collectAsState()
    val scores by FraudScores.scores.collectAsState()
    val conn by AppState.conn.collectAsState()
    @Suppress("UNUSED_VARIABLE") val health = AppState.health.collectAsState().value
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val o = openedOf(ref)
    if (o == null) {
        Txt("This proxy is not here any more.", type(15.sp, FontWeight.Medium, C.ink2), modifier = Modifier.padding(20.dp))
        return
    }
    val on = CheckerId.entries.filter { checkers[it]?.answers(it) == true }
    val off = CheckerId.entries.filter { it !in on }
    LaunchedEffect(o.exitIp, on) {
        val ip = o.exitIp ?: return@LaunchedEffect
        for (id in on) FraudScores.want(id, listOf(ip))
    }

    // The name, kept as it is typed (a moment after the last key, for a saved one).
    var name by remember(ref.key) { mutableStateOf(o.name) }
    LaunchedEffect(ref.key, name) {
        if (name.trim() == o.name.trim()) return@LaunchedEffect
        delay(450)
        val id = o.savedId
        if (id == null) {
            Settings.nameFree(o.addr, name.trim())
        } else {
            try {
                AppState.setLibrary(Engine.obj("rename", jsonOf("id" to id, "name" to name.trim())))
            } catch (e: EngineError) {
                AppState.toast(e.message ?: "The name was not saved")
            }
        }
    }

    // Head: the flag, the proxy itself or its name, where it is.
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (o.cc != null) Flag(o.cc, 36.dp, 27.dp) else Box(Modifier.size(36.dp, 27.dp), contentAlignment = Alignment.Center) { Ic(I.globe, 24.dp, C.ink3) }
        // Where it is first, then the proxy itself (2026-10-12).
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Txt(o.place, type(14.sp, FontWeight.SemiBold, C.ink2), maxLines = 1)
            Txt(name.trim().ifEmpty { o.addr }, type(21.sp, FontWeight.Bold, spacing = (-0.015).em, numbers = true), maxLines = 1)
        }
    }

    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 12.dp)) {
        Field(name, { name = it.take(60) }, placeholder = "Give it a name, like Shop account", label = "Name", height = 52.dp, surface = C.bg, style = type(15.5.sp, FontWeight.Bold, C.ink))
        Spacer(Modifier.height(10.dp))
        Line()
        Fact("Proxy") {
            FactText(o.addr)
            IconBtn(I.copy, {
                copy(context, o.addr)
                AppState.toast("${o.addr} copied")
            }, size = 30.dp, glyph = 18.dp, description = "Copy the proxy", tint = C.ink2)
        }
        o.proto?.let { Fact("Protocol") { FactText(it) } }
        o.kind?.let { Fact("Type") { FactText(it) } }
        o.ms?.let { ms ->
            Fact("Speed") {
                Bars(ms)
                FactText(speedText(ms))
            }
        }
        val exit = o.exitIp
        if (exit != null && exit != o.addr.substringBeforeLast(':')) Fact("Comes out as") { FactText(exit) }

        Txt("Fraud score", type(13.sp, FontWeight.Bold, C.ink3), modifier = Modifier.padding(top = 18.dp, bottom = 2.dp))
        if (o.exitIp == null) {
            Txt("Known once it is checked from this phone.", type(13.5.sp, FontWeight.SemiBold, C.ink2), modifier = Modifier.padding(top = 6.dp))
        } else {
            if (on.isNotEmpty()) Line()
            for (id in on) ScoreFact(id.label, scoreFor(scores, id, o.exitIp))
        }
        if (off.isNotEmpty()) {
            Txt(
                "More fraud checkers",
                type(13.5.sp, FontWeight.Bold, C.blueInk),
                modifier = Modifier.padding(top = 10.dp).pressable({
                    nav.sheet = null
                    nav.push(Page.Fraud)
                }, scale = 0.98f),
            )
        }
        if (o.savedId != null) {
            var sure by remember(ref.key) { mutableStateOf(false) }
            LaunchedEffect(sure) {
                if (sure) {
                    delay(3000)
                    sure = false
                }
            }
            TextBtn(if (sure) "Tap again to remove it" else "Remove from My proxies", {
                if (!sure) {
                    sure = true
                    return@TextBtn
                }
                val id = o.savedId ?: return@TextBtn
                scope.launch {
                    try {
                        AppState.setLibrary(Engine.obj("forget", jsonOf("id" to id)))
                        JustAdded.forget(id)
                        nav.sheet = null
                        AppState.toast("${o.title} removed")
                    } catch (e: EngineError) {
                        AppState.toast(e.message ?: "It was not removed")
                    }
                }
            }, Modifier.padding(top = 14.dp), ink = C.bad)
        }
    }

    // Foot: Save a free one, and Connect.
    Line()
    val st = conn.of(o.ref.key)
    val saved = o.savedId != null || library.proxies.any { it.address == o.addr }
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 22.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (!saved) {
            LineBtn("Save", {
                scope.launch {
                    val line = if (o.proto == "SOCKS5") "socks5://${o.addr}" else o.addr
                    try {
                        val r = Engine.obj("add", jsonOf("text" to line, "asGroup" to false))
                        r.optJSONObject("library")?.let(AppState::setLibrary)
                        val ids = r.optJSONObject("added")?.optJSONArray("ids")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty()
                        val given = name.trim()
                        if (given.isNotEmpty() && ids.isNotEmpty()) {
                            AppState.setLibrary(Engine.obj("rename", jsonOf("id" to ids[0], "name" to given)))
                        }
                        JustAdded.added(ids)
                        AppState.toast("${given.ifEmpty { o.addr }} is in My proxies")
                    } catch (e: EngineError) {
                        AppState.toast(e.message ?: "It was not saved")
                    }
                }
            }, Modifier.weight(1f), icon = I.save, height = 56.dp)
        }
        val inUse = st is RowState.On || (st is RowState.Bad && conn.place == o.ref.key && conn.running)
        Btn(
            when {
                inUse -> "Disconnect"
                st is RowState.Busy -> "Cancel"
                else -> "Connect"
            },
            {
                nav.sheet = null
                go(nav, o.ref, conn)
            },
            Modifier.weight(1f),
            kind = if (inUse || st is RowState.Busy) com.hproxy.app.ui.kit.BtnKind.Raised else com.hproxy.app.ui.kit.BtnKind.Blue,
        )
    }
}

/** What the free list shows first. */
@Composable
fun SortSheet(nav: Nav) {
    SheetHead("Show first")
    Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 24.dp)) {
        for (k in com.hproxy.app.ui.SortKey.entries) {
            SheetRow(nav.sort == k, k.title, k.why) {
                nav.sort = k
                nav.sheet = null
            }
        }
    }
}
