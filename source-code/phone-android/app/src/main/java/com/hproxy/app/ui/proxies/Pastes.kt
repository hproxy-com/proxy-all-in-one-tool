package com.hproxy.app.ui.proxies

import com.hproxy.app.engine.ProxyItem
import java.util.Calendar

/*
 * Every paste is its own group in My proxies, as on the computer (desktop-app/src/lib/pastes.ts):
 * easier to delete, to edit, and to know when they came. A paste is the proxies saved in one go: the
 * library stamps them with one added time (proxy-engine/hproxy-places, add_proxies), so the pastes
 * are read from that time, the ones made before this day too, and nothing new is kept anywhere. A
 * proxy added on its own goes with the others added one at a time.
 */

/** The proxies added one at a time, as one list of their own. */
internal const val ONE_AT_A_TIME = "one-at-a-time"

internal data class Paste(
    /** `paste-<added time>`, or ONE_AT_A_TIME. */
    val key: String,
    /** When they were saved (Unix ms); 0 for the ones added one at a time. */
    val addedAt: Long,
    /** The name they share ("Shop" for "Shop 1" to "Shop 12"), or "". */
    val name: String,
    val proxies: List<ProxyItem>,
)

/** The pastes of a list, in the list's own order: a paste stands where its first proxy does. */
internal fun pastesOf(list: List<ProxyItem>): List<Paste> {
    val together = list.groupingBy { it.addedAt }.eachCount()
    val pastes = LinkedHashMap<String, MutableList<ProxyItem>>()
    for (p in list) {
        val paste = p.addedAt > 0 && (together[p.addedAt] ?: 0) > 1
        pastes.getOrPut(if (paste) "paste-${p.addedAt}" else ONE_AT_A_TIME) { mutableListOf() }.add(p)
    }
    return pastes.map { (key, proxies) ->
        if (key == ONE_AT_A_TIME) {
            Paste(key, 0L, "", proxies)
        } else {
            Paste(key, proxies.first().addedAt, sharedName(proxies.map { it.name }), proxies)
        }
    }
}

/** The name every proxy of a paste carries, its number taken off; "" when they carry none or
 *  different ones. */
internal fun sharedName(names: List<String?>): String {
    val bases = names.map { (it ?: "").replace(Regex("\\s+\\d+$"), "").trim() }
    val first = bases.firstOrNull().orEmpty()
    return if (first.isNotEmpty() && bases.all { it == first }) first else ""
}

private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** When a paste came in, in this phone's time: "today at 14:05", "yesterday at 09:12", "19 Oct at
 *  03:12", "19 Oct 2025 at 03:12". */
internal fun pastedWhen(at: Long, now: Long = System.currentTimeMillis()): String {
    val day = Calendar.getInstance().apply { timeInMillis = at }
    val today = Calendar.getInstance().apply { timeInMillis = now }
    val yesterday = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -1) }
    fun same(a: Calendar, b: Calendar) = a.get(Calendar.YEAR) == b.get(Calendar.YEAR) && a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)
    val time = "%02d:%02d".format(day.get(Calendar.HOUR_OF_DAY), day.get(Calendar.MINUTE))
    return when {
        same(day, today) -> "today at $time"
        same(day, yesterday) -> "yesterday at $time"
        else -> {
            val year = if (day.get(Calendar.YEAR) == today.get(Calendar.YEAR)) "" else " ${day.get(Calendar.YEAR)}"
            "${day.get(Calendar.DAY_OF_MONTH)} ${MONTHS[day.get(Calendar.MONTH)]}$year at $time"
        }
    }
}

/** A paste's title: its name, else when it came in ("Pasted today at 14:05"). */
internal fun pasteTitle(paste: Paste, now: Long = System.currentTimeMillis()): String = when {
    paste.key == ONE_AT_A_TIME -> "Added one at a time"
    paste.name.isNotEmpty() -> paste.name
    else -> "Pasted ${pastedWhen(paste.addedAt, now)}"
}
