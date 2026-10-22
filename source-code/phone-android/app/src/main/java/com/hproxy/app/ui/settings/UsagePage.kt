package com.hproxy.app.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.hproxy.app.state.Usage
import com.hproxy.app.ui.kit.PushHead
import com.hproxy.app.ui.kit.Toggle
import com.hproxy.app.ui.kit.Txt
import com.hproxy.app.ui.theme.C
import com.hproxy.app.ui.theme.type

/* Usage counts (state/Usage.kt) are switched on here, in Settings, and nowhere else. Until
   2026-10-22 a sheet asked once, a moment after the app first opened; the choice lives in
   Settings, so nobody is asked. Nothing is counted until the switch is on. */

/** What a report holds, one line each. */
@Composable
private fun HoldsBox() {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.s1).border(1.dp, C.line, RoundedCornerShape(12.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (line in Usage.HOLDS) Txt(line, type(14.sp, FontWeight.Medium, C.ink, lineHeight = 19.sp))
    }
}

/** Settings, "Usage counts": the switch, what a report holds, and the last one exactly as it went. */
@Composable
fun UsagePage(onBack: () -> Unit) {
    val view by Usage.view.collectAsState()
    Column(Modifier.fillMaxSize().background(C.bg)) {
        PushHead(onBack)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 40.dp)) {
            Txt("Usage counts", type(26.sp, FontWeight.Bold, spacing = (-0.02).em))
            Txt(
                "Once a day, a few counts about the day before, so we fix what fails most and build what you use.",
                type(15.sp, FontWeight.Medium, C.ink2, lineHeight = 22.sp),
                modifier = Modifier.padding(top = 8.dp, bottom = 14.dp),
            )
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Txt("Send once a day", type(16.5.sp, FontWeight.Bold), modifier = Modifier.weight(1f))
                Toggle(view?.answer == Usage.Answer.Yes, { on -> Usage.answer(on) })
            }
            Txt(
                "${Usage.NEVER} Off deletes this copy's random number and its counts.",
                type(13.5.sp, FontWeight.Medium, C.ink2, lineHeight = 19.sp),
                modifier = Modifier.padding(bottom = 18.dp),
            )
            Section("A report holds") { HoldsBox() }
            Section("The last one sent") {
                val last = view?.last
                Txt(
                    last?.toString(2) ?: "Nothing sent yet. The first report goes the day after you switch it on.",
                    type(12.5.sp, FontWeight.Medium, C.ink2, lineHeight = 18.sp).copy(fontFamily = FontFamily.Monospace),
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.s1).border(1.dp, C.line, RoundedCornerShape(12.dp)).padding(14.dp),
                )
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(bottom = 18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Txt(title, type(13.sp, FontWeight.Bold, C.ink3, spacing = 0.04.em))
        content()
    }
}
