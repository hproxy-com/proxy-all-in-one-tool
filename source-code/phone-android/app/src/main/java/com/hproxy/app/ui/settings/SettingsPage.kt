package com.hproxy.app.ui.settings

import android.content.Intent
import android.provider.Settings as AndroidSettings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
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
import com.hproxy.app.BuildConfig
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.jsonOf
import com.hproxy.app.state.AppState
import com.hproxy.app.state.CheckerId
import com.hproxy.app.state.FraudScores
import com.hproxy.app.state.Settings
import com.hproxy.app.state.SupportChat
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.Page
import com.hproxy.app.ui.kit.Glyph
import com.hproxy.app.ui.kit.HMark
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.IconBtn
import com.hproxy.app.ui.kit.Toggle
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.proxies.Field
import com.hproxy.app.ui.proxies.TextBtn
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.type
import kotlinx.coroutines.launch
import org.json.JSONArray

/**
 * Settings: a few things, each a row with its glyph alone (pure icons). No
 * account and no devices (2026-10-09: what matters is the connector and the checker). An idea and a
 * question both go to the chat.
 */
@Composable
fun SettingsPage(nav: Nav, onBack: () -> Unit) {
    val context = LocalContext.current
    val prefs by Settings.prefs.collectAsState()
    val rules by Settings.rules.collectAsState()
    val checkers by Settings.checkers.collectAsState()
    val using = CheckerId.entries.filter { checkers[it]?.answers(it) == true }.joinToString(", ") { it.label }
    val special = if (prefs.allThroughProxy) rules.values.count { it.proxy == false } else rules.values.count { it.proxy == true }
    val apps = when {
        prefs.allThroughProxy && special == 0 -> "All apps"
        prefs.allThroughProxy -> "All but $special"
        else -> if (special == 1) "1 app" else "$special apps"
    }

    Column(Modifier.fillMaxSize().background(C.bg)) {
        Row(
            Modifier
                .statusBarsPadding()
                .padding(start = 6.dp, top = 6.dp)
                .height(52.dp)
                .pressable(onBack, scale = 0.97f)
                .padding(end = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconBtn(I.left, onBack, size = 48.dp, glyph = 26.dp, description = "Back")
            Txt("Settings", type(22.sp, FontWeight.Bold, spacing = (-0.015).em))
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 8.dp, end = 8.dp, top = 14.dp, bottom = 30.dp)) {
            SetRow(I.shield, "Fraud score checkers", value = using.ifEmpty { "None" }, more = true) { nav.push(Page.Fraud) }
            SetRow(I.apps, "Apps that use the proxy", value = apps, more = true) { nav.push(Page.Apps) }
            // What the people of other apps ask for most: a kill switch.
            SetRow(I.lock, "If the proxy stops", value = if (prefs.blockWhenDown) "Block the internet" else "Use your own", more = true) {
                Settings.update { it.copy(blockWhenDown = !it.blockWhenDown) }
                AppState.rulesChanged()
                AppState.toast(if (!prefs.blockWhenDown) "If it stops, apps wait for it" else "If it stops, apps use your own internet")
            }
            SetRow(I.bolt, "Connect when the phone starts", end = {
                Toggle(prefs.connectOnStartup, { v -> Settings.update { it.copy(connectOnStartup = v) } })
            })
            SetRow(I.again, "Always on", value = "Phone settings", more = true) {
                context.startActivity(Intent(AndroidSettings.ACTION_VPN_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            SetRow(I.chat, "Talk to us", value = "HProxy support", more = true) { nav.go(com.hproxy.app.ui.Tab.Help) }
            SetRow(I.idea, "Send an idea", more = true) {
                SupportChat.setDraft("Idea: ")
                nav.go(com.hproxy.app.ui.Tab.Help)
            }
            Row(
                Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Box(Modifier.width(26.dp), contentAlignment = Alignment.Center) { HMark(18.dp, C.ink2) }
                Txt("Version", type(15.5.sp, FontWeight.SemiBold), modifier = Modifier.weight(1f))
                Txt(BuildConfig.VERSION_NAME, type(14.sp, FontWeight.SemiBold, C.ink2, numbers = true))
            }
        }
    }
}

/** A row of Settings: its glyph alone, its words, its value, and where it leads. */
@Composable
private fun SetRow(
    g: Glyph,
    title: String,
    value: String? = null,
    more: Boolean = false,
    end: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp)
            .let { if (onClick != null) it.pressable(onClick, scale = 0.985f) else it }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.width(26.dp), contentAlignment = Alignment.Center) { Ic(g, 22.dp, C.ink2) }
        Txt(title, type(15.5.sp, FontWeight.SemiBold), modifier = Modifier.weight(1f), maxLines = 1)
        if (value != null) Txt(value, type(14.sp, FontWeight.SemiBold, C.ink2), modifier = Modifier.widthIn(max = 150.dp), maxLines = 1)
        if (end != null) end()
        if (more) Ic(I.right, 20.dp, C.ink3)
    }
}

/**
 * The fraud score checkers, the computer app's five (desktop-app/src/lib/fraud.ts): each on or off,
 * with the person's own key where it needs one, and a test. Every proxy shows the score of the first
 * one that is on; an opened proxy shows them all.
 */
@Composable
fun FraudPage(onBack: () -> Unit) {
    val checkers by Settings.checkers.collectAsState()
    val own by AppState.ownIp.collectAsState()
    val health by AppState.health.collectAsState()
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().background(C.bg)) {
        Row(Modifier.statusBarsPadding().padding(start = 10.dp, top = 8.dp)) {
            IconBtn(I.left, onBack, glyph = 26.dp, description = "Back")
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 40.dp)) {
            Txt("Fraud score checkers", type(26.sp, FontWeight.Bold, spacing = (-0.02).em))
            Txt(
                "Every proxy shows the score of the first checker that is on. Turn on more to see theirs too, with your own keys.",
                type(15.sp, FontWeight.Medium, C.ink2, lineHeight = 22.sp),
                modifier = Modifier.padding(top = 8.dp, bottom = 6.dp),
            )
            for (id in CheckerId.entries) {
                val set = checkers[id] ?: continue
                var key by remember(id) { mutableStateOf(set.key) }
                val waiting = set.on && id.keyLabel != null && !id.keyOptional && set.key.isBlank()
                Column(Modifier.fillMaxWidth().padding(vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Txt(id.label, type(16.5.sp, FontWeight.Bold), modifier = Modifier.weight(1f))
                        Toggle(set.on, { v ->
                            Settings.setChecker(id, set.copy(on = v))
                            FraudScores.forget(id)
                        })
                    }
                    Txt(id.about, type(13.5.sp, FontWeight.Medium, C.ink2, lineHeight = 19.sp))
                    if (set.on && id.keyLabel != null) {
                        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Field(
                                key,
                                { v ->
                                    key = v
                                    Settings.setChecker(id, set.copy(key = v.trim()))
                                    FraudScores.forget(id)
                                },
                                placeholder = id.keyHint ?: id.keyLabel,
                                modifier = Modifier.weight(1f),
                                height = 46.dp,
                                surface = C.bg,
                                plain = true,
                                style = type(14.5.sp, FontWeight.Medium, C.ink),
                            )
                            TextBtn("Test", {
                                if (waiting) {
                                    AppState.toast("${id.label} needs your ${id.keyLabel}")
                                    return@TextBtn
                                }
                                // The address you appear as now: the proxy's while connected, else your own.
                                val ip = health?.exitIp ?: own?.ip ?: "1.1.1.1"
                                scope.launch {
                                    try {
                                        val a = Engine.arr("fraud", jsonOf("ips" to JSONArray(listOf(ip)), "service" to id.json(set.key)))
                                        val o = a.optJSONObject(0)
                                        val err = o?.optString("error")?.ifEmpty { null }
                                        AppState.toast(
                                            when {
                                                o == null -> "${id.label} did not answer"
                                                err != null -> "${id.label}: $err"
                                                else -> "${id.label} answered: $ip scores ${o.optInt("score")}"
                                            },
                                        )
                                    } catch (e: EngineError) {
                                        AppState.toast(e.message ?: "${id.label} did not answer")
                                    }
                                }
                            })
                        }
                    }
                    if (waiting) Txt("Waiting for your ${id.keyLabel}", type(13.sp, FontWeight.SemiBold, C.warn))
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(C.line))
            }
        }
    }
}
