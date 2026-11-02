package com.hproxy.app.ui.home

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.state.SupportChat
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.SheetKind
import com.hproxy.app.ui.Shelf
import com.hproxy.app.ui.Tab
import com.hproxy.app.ui.kit.Glyph
import com.hproxy.app.ui.kit.I
import com.hproxy.app.ui.kit.Ic
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.kit.pressable
import com.hproxy.app.ui.proxies.TextBtn
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.cut
import com.hproxy.app.ui.theme.type

/**
 * The first start: how do you want to start? (Most new copies come from Play's own search, with no
 * proxies yet.) The computer app's ways, and one more for someone who needs a proxy in a country:
 * it goes to the chat, where a person answers. Asked once (Root.kt). Skip, Back or a tap beside the
 * sheet closes it; the switch still never picks a free proxy by itself.
 */
@Composable
fun ColumnScope.WelcomeSheet(nav: Nav) {
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Txt("Welcome to HProxy", type(24.sp, FontWeight.Bold, spacing = (-0.02).em), modifier = Modifier.padding(top = 4.dp))
        Txt("How do you want to start?", type(15.sp, FontWeight.Medium, C.ink2), modifier = Modifier.padding(bottom = 4.dp))
        WelcomeWay(I.key, "I have proxies", "Paste them, scan a QR code or type one.") {
            nav.go(Tab.Proxies)
            nav.showShelf(Shelf.Mine)
            nav.open(SheetKind.Add)
        }
        WelcomeWay(I.globe, "Try a free proxy", "Public proxies by country. Fine for a look, never for logins.") {
            nav.go(Tab.Proxies)
            nav.showShelf(Shelf.Free)
        }
        WelcomeWay(I.checker, "Check a list", "Which proxies work, how fast, where they come out.") {
            nav.go(Tab.Checker)
        }
        WelcomeWay(I.chat, "I need a proxy in a country", "Tell us which one, a person answers right here.") {
            SupportChat.setDraft("A country I need: ")
            nav.go(Tab.Help)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextBtn("Skip", { nav.sheet = null }, ink = C.ink2)
        }
    }
}

/** A way in: its glyph alone, its words, inside a hairline. */
@Composable
private fun WelcomeWay(g: Glyph, title: String, words: String, onClick: () -> Unit) {
    val shape = cut(18.dp, 6.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .pressable(onClick, scale = 0.985f)
            .clip(shape)
            .border(1.dp, C.line, shape)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Ic(g, 24.dp, C.blueInk)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Txt(title, type(16.sp, FontWeight.Bold, spacing = (-0.01).em), maxLines = 1)
            Txt(words, type(13.5.sp, FontWeight.Medium, C.ink2, lineHeight = 19.sp))
        }
        Ic(I.right, 20.dp, C.ink3)
    }
}
