package com.hproxy.app.ui.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.Kind
import com.hproxy.app.engine.PlaceRef
import com.hproxy.app.engine.Shown
import com.hproxy.app.engine.countryName
import com.hproxy.app.engine.jsonOf
import com.hproxy.app.engine.str
import com.hproxy.app.state.AppState
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.kit.Btn
import com.hproxy.app.ui.kit.BtnKind
import com.hproxy.app.ui.kit.ChipRow
import com.hproxy.app.ui.kit.Group
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.IconBtn
import com.hproxy.app.ui.kit.IconKind
import com.hproxy.app.ui.kit.PushHead
import com.hproxy.app.ui.kit.Segments
import com.hproxy.app.ui.kit.SettingRow
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.Flag
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.kit.copy
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.T
import com.hproxy.app.ui.theme.type
import kotlinx.coroutines.launch

private enum class Format { Colon, At, Url }

private data class Line(val host: String, val port: Int, val user: String?, val pass: String?, val scheme: String?)

/**
 * Details: what this connection is (address, login, password on request, where you appear), and
 * its line in the format another app wants. The password is shown only when asked, and leaves the
 * engine only for this page.
 */
@Composable
fun DetailsPage(nav: Nav, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val library by AppState.library.collectAsState()
    val status by AppState.status.collectAsState()
    val health by AppState.health.collectAsState()
    // The connection's place as on the Connection page that opened this one (AppState.target).
    @Suppress("UNUSED_VARIABLE") val read = Pair(library, status)
    val ref = com.hproxy.app.state.AppState.target()
    val shown = com.hproxy.app.state.AppState.show(ref)
    var proto by remember { mutableStateOf("http") }
    var format by remember { mutableStateOf(Format.Colon) }
    var reveal by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf(false) }

    val line by produceState<Line?>(null, ref, status.member) {
        value = if (ref == null || ref is PlaceRef.Free) {
            status.freeExit?.substringBefore(' ')?.let { exit ->
                val host = exit.substringBeforeLast(':')
                val port = exit.substringAfterLast(':').toIntOrNull()
                if (port != null) Line(host, port, null, null, null) else null
            }
        } else {
            try {
                val o = Engine.obj("secret", jsonOf("place" to ref.json(), "member" to status.member))
                Line(o.optString("host"), o.optInt("port"), o.str("user"), o.str("pass"), o.str("scheme"))
            } catch (e: EngineError) {
                null
            }
        }
        value?.scheme?.let { if (it == "socks5") proto = "socks5" }
    }

    Column(Modifier.fillMaxSize().background(C.bg)) {
        PushHead(onBack)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 40.dp)) {
            if (shown != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Flag(shown.cc, 36.dp, 27.dp)
                    Column(Modifier.weight(1f)) {
                        Txt(shown.name, T.title.copy(fontSize = 24.sp), maxLines = 1)
                        val where = listOfNotNull(health?.city, health?.country ?: countryName(shown.cc)).joinToString(", ")
                        Txt(listOf(shown.kind.label, where).filter { it.isNotEmpty() }.joinToString(" · "), T.rowSub, maxLines = 1)
                    }
                }
            }
            Spacer(Modifier.height(18.dp))
            val l = line
            Group {
                Field("Address", l?.let { "${it.host}:${it.port}" } ?: "…", copyable = l?.let { "${it.host}:${it.port}" })
                if (l?.user != null) Field("Login", l.user, copyable = l.user)
                if (l?.pass != null) {
                    Field(
                        "Password",
                        if (reveal) l.pass else "••••••••",
                        copyable = l.pass,
                        extra = { IconBtn(I.eye, { reveal = !reveal }, kind = IconKind.Plain, size = 36.dp, glyph = 18.dp) },
                    )
                }
                Field("You appear as", if (status.running) health?.exitIp ?: "Checking" else "Not connected", last = true)
            }
            Spacer(Modifier.height(22.dp))
            Txt("Protocol", T.listHead)
            Spacer(Modifier.height(8.dp))
            Segments(proto, listOf("http" to "HTTP", "socks5" to "SOCKS5"), { proto = it })
            Spacer(Modifier.height(22.dp))
            Txt("Copy as", T.listHead)
            Spacer(Modifier.height(8.dp))
            ChipRow(
                format,
                listOf(Format.Colon to "host:port:user:pass", Format.At to "user:pass@host:port", Format.Url to "$proto://…"),
                { format = it },
                scroll = rememberScrollState(),
            )
            if (l != null) {
                val real = formatted(l, format, proto, l.pass)
                val shownLine = formatted(l, format, proto, if (reveal) l.pass else l.pass?.let { "••••••••" })
                Spacer(Modifier.height(12.dp))
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(C.s1)
                        .border(1.dp, C.line, RoundedCornerShape(14.dp))
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                ) {
                    Txt(shownLine, type(14.sp, FontWeight.SemiBold, numbers = true))
                }
                Spacer(Modifier.height(12.dp))
                Btn("Copy the line", {
                    copy(context, real)
                    AppState.toast("The line copied")
                }, Modifier.fillMaxWidth(), icon = I.copy)
            }
            if (ref != null && ref !is PlaceRef.Free) {
                Spacer(Modifier.height(18.dp))
                if (!removing) {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        Txt("Remove from this phone", type(14.5.sp, FontWeight.Bold, C.bad), modifier = Modifier.pressable({ removing = true }).padding(8.dp))
                    }
                } else {
                    Txt("Remove ${shown?.name ?: "it"}? It is gone from this phone; your plan is not touched.", T.body)
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Btn("Cancel", { removing = false }, Modifier.weight(1f), kind = BtnKind.Raised)
                        Btn("Remove", {
                            scope.launch {
                                if (status.place == ref) AppState.disconnect()
                                try {
                                    val method = if (ref is PlaceRef.Group) "forgetGroup" else "forget"
                                    val id = (ref as? PlaceRef.Group)?.id ?: (ref as PlaceRef.Proxy).id
                                    AppState.setLibrary(Engine.obj(method, jsonOf("id" to id)))
                                    AppState.toast("Removed")
                                    onBack()
                                } catch (e: EngineError) {
                                    AppState.toast(e.message ?: "Could not remove it")
                                }
                            }
                        }, Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

private fun formatted(l: Line, f: Format, proto: String, pass: String?): String {
    val login = if (l.user != null) "${l.user}:${pass ?: ""}" else null
    return when (f) {
        Format.Colon -> listOfNotNull(l.host, l.port.toString(), l.user, pass).joinToString(":")
        Format.At -> (login?.let { "$it@" } ?: "") + "${l.host}:${l.port}"
        Format.Url -> "$proto://" + (login?.let { "$it@" } ?: "") + "${l.host}:${l.port}"
    }
}

@Composable
private fun Field(label: String, value: String, copyable: String? = null, last: Boolean = false, extra: (@Composable () -> Unit)? = null) {
    val context = LocalContext.current
    SettingRow(last = last) {
        Txt(label, type(14.sp, FontWeight.SemiBold, C.ink2), modifier = Modifier.width(104.dp))
        Txt(value, type(14.5.sp, FontWeight.Bold, numbers = true), modifier = Modifier.weight(1f), maxLines = 1)
        if (extra != null) extra()
        if (copyable != null) {
            IconBtn(I.copy, {
                copy(context, copyable)
                AppState.toast("$label copied")
            }, kind = IconKind.Plain, size = 36.dp, glyph = 18.dp)
        }
    }
}
