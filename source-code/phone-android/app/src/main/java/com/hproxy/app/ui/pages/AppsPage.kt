package com.hproxy.app.ui.pages

import android.graphics.Bitmap
import android.graphics.Canvas as AndroidCanvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hproxy.app.engine.Shown
import com.hproxy.app.firewall.Firewall
import com.hproxy.app.firewall.InstalledApp
import com.hproxy.app.firewall.Net
import com.hproxy.app.state.AppRule
import com.hproxy.app.state.AppState
import com.hproxy.app.state.Settings
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.kit.Group
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.PushHead
import com.hproxy.app.ui.kit.Segments
import com.hproxy.app.ui.kit.SettingRow
import com.hproxy.app.ui.kit.Toggle
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.settingText
import com.hproxy.app.ui.kit.slideWith
import com.hproxy.app.ui.proxies.Field
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.T
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private enum class View { Proxy, Wifi, Mobile }

/**
 * Which apps: per app, through the proxy or not, and allowed on Wi-Fi and on mobile data (the
 * firewall, NetGuard as motivation, built here on the VPN this app already runs: one VPN at a time
 * on Android, so a firewall and a proxy app could never run side by side). Blocking works with or
 * without a proxy connected.
 */
@Composable
fun AppsPage(nav: Nav, onBack: () -> Unit) {
    val context = LocalContext.current
    val prefs by Settings.prefs.collectAsState()
    val rules by Settings.rules.collectAsState()
    val library by AppState.library.collectAsState()
    val status by AppState.status.collectAsState()
    val net by AppState.net.collectAsState()
    var view by remember { mutableStateOf(View.Proxy) }
    var search by remember { mutableStateOf("") }
    val apps by produceState<List<InstalledApp>?>(null) {
        value = withContext(Dispatchers.IO) { Firewall.installed(context, fresh = true) }
    }
    val known = Settings.knownApps
    val place = Shown.find(library, status.place ?: library.picked)?.name ?: "your proxy"

    fun set(pkg: String, next: AppRule) {
        Settings.setRule(pkg, next)
        AppState.rulesChanged()
    }

    Column(Modifier.fillMaxSize().background(C.bg)) {
        PushHead(onBack)
        LazyColumn(contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 40.dp)) {
            item {
                Txt("Which apps", T.title)
                Spacer(Modifier.height(8.dp))
                Txt(
                    when (view) {
                        View.Proxy -> "Pick which apps go out through $place."
                        View.Wifi -> "Turn an app off to keep it off Wi-Fi, with or without a proxy." + if (net == Net.Wifi) " You are on Wi-Fi now." else ""
                        View.Mobile -> "Turn an app off to keep it off mobile data, with or without a proxy." + if (net == Net.Mobile) " You are on mobile data now." else ""
                    },
                    T.body,
                )
                Spacer(Modifier.height(16.dp))
                Segments(view, listOf(View.Proxy to "Proxy", View.Wifi to "Wi-Fi", View.Mobile to "Mobile data"), { view = it })
                Spacer(Modifier.height(14.dp))
                // What a view shows comes in from its tab's side (kit/Choice.kt). The column is there
                // in every view, so it remembers the view before and slides from that side.
                Column(Modifier.slideWith(view, View.entries)) {
                    if (view == View.Proxy) {
                        Group {
                            SettingRow(last = true) {
                                Box(Modifier.size(36.dp).clip(cut(12.dp, 4.dp)).background(C.blue), contentAlignment = Alignment.Center) {
                                    Ic(I.apps, 20.dp, C.white)
                                }
                                Txt("All apps", settingText, modifier = Modifier.weight(1f))
                                Toggle(prefs.allThroughProxy, { all ->
                                    Settings.update { it.copy(allThroughProxy = all) }
                                    AppState.rulesChanged()
                                })
                            }
                        }
                        Spacer(Modifier.height(10.dp))
                        Txt(
                            if (prefs.allThroughProxy) "Every app goes through it. Turn one off below to let it use your own internet."
                            else "Only the apps turned on below go through it.",
                            type(13.5.sp, FontWeight.SemiBold, C.ink3, lineHeight = 19.sp),
                        )
                        Spacer(Modifier.height(14.dp))
                    }
                }
                Field(search, { search = it }, placeholder = "Search your apps", lead = com.hproxy.app.ui.kit.I.search, plain = true)
                Spacer(Modifier.height(8.dp))
            }
            val list = apps
            if (list == null) {
                item { Txt("Reading your apps", type(14.sp, FontWeight.SemiBold, C.ink3), modifier = Modifier.padding(16.dp)) }
            } else {
                val q = search.trim().lowercase()
                val shown = list.filter { (prefs.showSystemApps || !it.system || rules.containsKey(it.pkg)) && (q.isEmpty() || it.label.lowercase().contains(q)) }
                items(shown, key = { it.pkg }) { app ->
                    val rule = Firewall.ruleOf(app.pkg, rules, prefs, known)
                    val (on, flip) = when (view) {
                        View.Proxy -> Firewall.throughProxy(rule, prefs) to { v: Boolean -> set(app.pkg, rule.copy(proxy = if (v == prefs.allThroughProxy) null else v)) }
                        View.Wifi -> rule.wifi to { v: Boolean -> set(app.pkg, rule.copy(wifi = v)) }
                        View.Mobile -> rule.mobile to { v: Boolean -> set(app.pkg, rule.copy(mobile = v)) }
                    }
                    AppRow(app, on, rule, view, flip, Modifier.slideWith(view, View.entries))
                }
            }
            item {
                Spacer(Modifier.height(18.dp))
                Group {
                    SettingRow {
                        Txt("Show system apps", settingText, modifier = Modifier.weight(1f))
                        Toggle(prefs.showSystemApps, { v -> Settings.update { it.copy(showSystemApps = v) } })
                    }
                    SettingRow {
                        Column(Modifier.weight(1f)) {
                            Txt("Tell me when a blocked app tries", settingText)
                        }
                        Toggle(prefs.tellBlocked, { v ->
                            if (v) nav.askNotifications()
                            Settings.update { it.copy(tellBlocked = v) }
                            AppState.rulesChanged()
                        })
                    }
                    SettingRow(last = true) {
                        Column(Modifier.weight(1f)) {
                            Txt("Block new apps until I allow them", settingText)
                        }
                        Toggle(prefs.blockNewApps, { v ->
                            if (v) Settings.knownApps = (apps ?: emptyList()).map { it.pkg }.toSet()
                            Settings.update { it.copy(blockNewApps = v) }
                            AppState.rulesChanged()
                        })
                    }
                }
            }
        }
    }
}

@Composable
private fun AppRow(app: InstalledApp, on: Boolean, rule: AppRule, view: View, flip: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        AppIcon(app.pkg)
        Column(Modifier.weight(1f)) {
            Txt(app.label, settingText, maxLines = 1)
            val note = buildList {
                if (view != View.Wifi && !rule.wifi) add("Off Wi-Fi")
                if (view != View.Mobile && !rule.mobile) add("Off mobile data")
                if (app.system) add("System")
            }.joinToString(" · ")
            if (note.isNotEmpty()) Txt(note, type(12.5.sp, FontWeight.SemiBold, C.ink3), maxLines = 1)
        }
        Toggle(on, flip)
    }
}

/** An app's own icon, read off the screen's thread once per row. */
@Composable
private fun AppIcon(pkg: String) {
    val context = LocalContext.current
    val icon by produceState<ImageBitmap?>(null, pkg) {
        value = withContext(Dispatchers.IO) {
            try {
                val d = context.packageManager.getApplicationIcon(pkg)
                val size = 96
                val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
                val c = AndroidCanvas(bmp)
                d.setBounds(0, 0, size, size)
                d.draw(c)
                bmp.asImageBitmap()
            } catch (e: Exception) {
                null
            }
        }
    }
    Box(Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(C.s2)) {
        icon?.let { Image(it, contentDescription = null, modifier = Modifier.size(36.dp)) }
    }
}
