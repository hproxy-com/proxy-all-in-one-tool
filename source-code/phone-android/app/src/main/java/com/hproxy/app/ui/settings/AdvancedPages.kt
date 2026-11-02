package com.hproxy.app.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.state.AppState
import com.hproxy.app.state.Settings
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.PushHead
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type
import kotlinx.coroutines.delay

/* The phone's advanced connection settings: which sites use the proxy, and a proxy in front of
   it. The engine holds both (proxy-engine/hproxy-relay, routes.rs); these pages keep what the
   person chose and tell it (AppState.routingChanged). */

/** One choice of a few: a tick on its right when it is the one. */
@Composable
private fun OneOf(title: String, words: String?, on: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .pressable(onClick, scale = 0.985f)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Txt(title, type(15.5.sp, FontWeight.SemiBold), maxLines = 1)
            if (words != null) Txt(words, type(13.5.sp, FontWeight.Medium, C.ink2, lineHeight = 19.sp))
        }
        Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
            if (on) Ic(I.check, 22.dp, C.blueInk)
        }
    }
}

/** Settings, "Sites": all of them, all except the ones named, or only those. */
@Composable
fun SitesPage(onBack: () -> Unit) {
    val prefs by Settings.prefs.collectAsState()
    val problem by AppState.routingProblem.collectAsState()
    var sites by remember { mutableStateOf(prefs.routeSites) }
    // Told once the typing rests: the open connections end with every change.
    LaunchedEffect(sites) {
        delay(700)
        if (sites != Settings.prefs.value.routeSites) {
            Settings.update { it.copy(routeSites = sites) }
            AppState.routingChanged()
        }
    }
    val choose = { mode: String ->
        Settings.update { it.copy(routeMode = mode) }
        AppState.routingChanged()
    }
    Column(Modifier.fillMaxSize().background(C.bg)) {
        PushHead(onBack)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 40.dp)) {
            Txt("Sites", type(26.sp, FontWeight.Bold, spacing = (-0.02).em))
            Txt(
                "Which sites use the proxy. A site that skips it leaves on your own address, also with the kill switch on.",
                type(15.sp, FontWeight.Medium, C.ink2, lineHeight = 22.sp),
                modifier = Modifier.padding(top = 8.dp, bottom = 14.dp),
            )
            OneOf("All sites", null, prefs.routeMode == "all") { choose("all") }
            OneOf("All except these", "These go straight out", prefs.routeMode == "except") { choose("except") }
            OneOf("Only these", "Everything else goes straight out", prefs.routeMode == "only") { choose("only") }
            if (prefs.routeMode != "all") {
                val shape = cut(14.dp, 5.dp)
                Box(
                    Modifier
                        .padding(top = 12.dp)
                        .fillMaxWidth()
                        .heightIn(min = 132.dp)
                        .clip(shape)
                        .background(C.bg)
                        .border(1.dp, if (problem != null) C.bad else C.line, shape)
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                ) {
                    if (sites.isEmpty()) Txt("example.com, one a line", type(15.sp, FontWeight.Medium, C.ink3))
                    BasicTextField(
                        sites,
                        { sites = it },
                        textStyle = type(15.sp, FontWeight.Medium, C.ink, numbers = true, lineHeight = 22.sp),
                        cursorBrush = SolidColor(C.blueInk),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 108.dp),
                    )
                }
                problem?.let {
                    Txt(it, type(13.5.sp, FontWeight.SemiBold, C.bad, lineHeight = 19.sp), modifier = Modifier.padding(top = 8.dp))
                }
            }
        }
    }
}

/** Settings, "Two proxies in a row": the saved proxy your connection goes through first. */
@Composable
fun FirstHopPage(onBack: () -> Unit) {
    val prefs by Settings.prefs.collectAsState()
    val library by AppState.library.collectAsState()
    val pick = { id: String ->
        Settings.update { it.copy(firstHop = id) }
        AppState.routingChanged()
    }
    Column(Modifier.fillMaxSize().background(C.bg)) {
        PushHead(onBack)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 40.dp)) {
            Txt("Two proxies in a row", type(26.sp, FontWeight.Bold, spacing = (-0.02).em))
            Txt(
                "Your connection goes through this proxy first, then through the one you connect to. That second proxy only sees the first one's address.",
                type(15.sp, FontWeight.Medium, C.ink2, lineHeight = 22.sp),
                modifier = Modifier.padding(top = 8.dp, bottom = 14.dp),
            )
            OneOf("Off", null, prefs.firstHop.isEmpty()) { pick("") }
            for (p in library.proxies) {
                OneOf(p.name ?: p.address, if (p.name != null) p.address else null, prefs.firstHop == p.id) { pick(p.id) }
            }
        }
    }
}
