package com.hproxy.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.ui.Alignment
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.zIndex
import com.hproxy.app.state.AppState
import com.hproxy.app.ui.checker.CardSheet
import com.hproxy.app.ui.checker.CheckTypeSheet
import com.hproxy.app.ui.checker.CheckerTab
import com.hproxy.app.ui.checker.JudgeSheet
import com.hproxy.app.ui.connection.ConnectionPage
import com.hproxy.app.ui.help.HelpTab
import com.hproxy.app.ui.home.HomeTab
import com.hproxy.app.ui.kit.LocalTint
import com.hproxy.app.ui.kit.Sheet
import com.hproxy.app.ui.kit.Toast
import com.hproxy.app.ui.kit.slideWith
import com.hproxy.app.ui.nav.NavBar
import com.hproxy.app.ui.pages.AppsPage
import com.hproxy.app.ui.pages.ChecksPage
import com.hproxy.app.ui.pages.DetailsPage
import com.hproxy.app.ui.proxies.AddSheet
import com.hproxy.app.ui.proxies.GroupPage
import com.hproxy.app.ui.proxies.ProxiesTab
import com.hproxy.app.ui.proxies.ProxySheet
import com.hproxy.app.ui.proxies.SortSheet
import com.hproxy.app.ui.settings.FraudPage
import com.hproxy.app.ui.settings.SettingsPage
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.Glide
import kotlinx.coroutines.delay

/**
 * The whole app on one screen, shaped like the big VPN apps (2026-10-12): a tab (Home, Proxies,
 * Checker, Settings) above the nav with the H button in its middle; pages that slide in from the
 * right over everything (the connection in detail, a group, the fraud checkers, Help, the tools);
 * sheets that rise over all of it. Back takes the top thing away: a sheet, then a page, then another
 * tab goes back to Home, and on Home the app goes to the background, still running.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun Root(nav: Nav) {
    var toast by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        AppState.toasts.collect {
            toast = it
            delay(2200)
            if (toast == it) toast = null
        }
    }
    val activity = LocalContext.current as? android.app.Activity
    BackHandler(nav.pages.isNotEmpty()) { nav.pop() }
    BackHandler(nav.pages.isEmpty() && nav.sheet == null && nav.tab != Tab.Home) { nav.go(Tab.Home) }
    // On Home, Back puts the app away, still running (the VPN lives in its service).
    BackHandler(nav.pages.isEmpty() && nav.sheet == null && nav.tab == Tab.Home) { activity?.moveTaskToBack(true) }

    // While the keyboard is up the nav steps aside, so what is typed in sits right on it.
    val keyboard = WindowInsets.isImeVisible
    val tabs = rememberSaveableStateHolder()
    val close = { nav.sheet = null }

    CompositionLocalProvider(LocalTint provides C.ink) {
        Box(Modifier.fillMaxSize().background(C.bg)) {
            Column(Modifier.fillMaxSize()) {
                // The tab pressed comes in from its side, as the computer app's pages do.
                Box(Modifier.weight(1f).fillMaxWidth().slideWith(nav.tab, Tab.entries)) {
                    tabs.SaveableStateProvider(nav.tab.name) {
                        when (nav.tab) {
                            Tab.Home -> HomeTab(nav)
                            Tab.Proxies -> ProxiesTab(nav)
                            Tab.Checker -> CheckerTab(nav)
                            Tab.Help -> HelpTab()
                        }
                    }
                }
                // It slides down behind the keyboard and back up, never blinks away.
                AnimatedVisibility(
                    !keyboard,
                    enter = expandVertically(tween(260, easing = Glide), expandFrom = Alignment.Top),
                    exit = shrinkVertically(tween(200, easing = Glide), shrinkTowards = Alignment.Top),
                ) { NavBar(nav) }
            }

            for (page in Page.entries) {
                // Pages stack in the order they were opened, and keep their place while they slide away.
                val z = nav.pages.indexOf(page)
                var lastZ by remember { mutableStateOf(0f) }
                if (z >= 0) lastZ = z.toFloat()
                AnimatedVisibility(
                    page in nav.pages,
                    modifier = Modifier.zIndex(lastZ + 1f),
                    enter = slideInHorizontally(tween(460, easing = Glide)) { (it * 1.04f).toInt() },
                    exit = slideOutHorizontally(tween(420, easing = Glide)) { (it * 1.04f).toInt() },
                ) {
                    val back = { nav.close(page) }
                    Box(Modifier.fillMaxSize().background(C.bg)) {
                        when (page) {
                            Page.Connection -> ConnectionPage(nav, back)
                            Page.Group -> GroupPage(nav, back)
                            Page.Fraud -> FraudPage(back)
                            Page.Settings -> SettingsPage(nav, back)
                            Page.Checks -> ChecksPage(nav, back)
                            Page.Apps -> AppsPage(nav, back)
                            Page.Details -> DetailsPage(nav, back)
                        }
                    }
                }
            }

            // Sheets rise over the pages too.
            Box(Modifier.fillMaxSize().zIndex(50f)) {
                Sheet(nav.sheet == SheetKind.Add, close, heightFraction = null) { AddSheet(nav) }
                Sheet(nav.sheet == SheetKind.Proxy, close, heightFraction = 0.84f) { ProxySheet(nav) }
                Sheet(nav.sheet == SheetKind.Sort, close, heightFraction = null) { SortSheet(nav) }
                Sheet(nav.sheet == SheetKind.Judge, close, heightFraction = null) { JudgeSheet(nav) }
                Sheet(nav.sheet == SheetKind.CheckType, close, heightFraction = null) { CheckTypeSheet(nav) }
                Sheet(nav.sheet == SheetKind.Card, close, heightFraction = null) { CardSheet(nav) }
            }
            Box(Modifier.fillMaxSize().zIndex(100f)) { Toast(toast) }
        }
    }
}
