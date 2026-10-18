package com.hproxy.app.engine

import java.util.Calendar
import java.util.Locale

/**
 * The last day of a saved proxy's or group's plan, read the same way as every HProxy app reads it
 * (proxy-engine/hproxy-places, clean_date and days_left; the extension's expiry.js): one day of the
 * calendar written YYYY-MM-DD, counted on this phone's own calendar. Plain arithmetic: Android 7
 * has no java.time. Digits are written the US way: a phone in Arabic would otherwise write the
 * day in digits no other app reads.
 */
object Expiry {
    /** How many days before its last day a plan counts as ending soon. */
    const val SOON = 3

    enum class Tone { Quiet, Warn, Bad }

    /** How a last day stands: the days left, in words, and how loud. */
    data class Left(val days: Int, val words: String, val tone: Tone)

    private val DAY = Regex("""^(\d{4})-(\d{2})-(\d{2})$""")
    private val MONTHS = arrayOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    /** Year, month and day of a day written YYYY-MM-DD (2000 to 2199), or null. */
    private fun ymd(day: String?): Triple<Int, Int, Int>? {
        val m = DAY.matchEntire(day?.trim() ?: return null) ?: return null
        val (y, mo, d) = m.destructured.toList().map { it.toInt() }
        if (y !in 2000..2199 || mo !in 1..12) return null
        val leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
        val last = intArrayOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[mo - 1]
        return if (d in 1..last) Triple(y, mo, d) else null
    }

    private fun write(y: Int, m: Int, d: Int): String = String.format(Locale.US, "%04d-%02d-%02d", y, m, d)

    /** `day` when it is one day of the calendar, else null. */
    fun cleanDate(day: String?): String? = ymd(day)?.let { (y, m, d) -> write(y, m, d) }

    /** Today on this phone's own calendar. */
    fun today(now: Calendar = Calendar.getInstance()): String =
        write(now.get(Calendar.YEAR), now.get(Calendar.MONTH) + 1, now.get(Calendar.DAY_OF_MONTH))

    /** A day picked on Android's calendar (its months count from 0). */
    fun picked(year: Int, month0: Int, day: Int): String = write(year, month0 + 1, day)

    /** Year, month from 0 and day of `day`, for Android's calendar to open on; today without one. */
    fun parts(day: String?): Triple<Int, Int, Int> {
        ymd(day)?.let { (y, m, d) -> return Triple(y, m - 1, d) }
        val now = Calendar.getInstance()
        return Triple(now.get(Calendar.YEAR), now.get(Calendar.MONTH), now.get(Calendar.DAY_OF_MONTH))
    }

    /** Days since 1970-01-01 (H. Hinnant's days_from_civil, as the library counts them). The
     *  years here are 1999 and later, so plain division rounds the way the formula wants. */
    private fun dayNumber(y0: Int, m: Int, d: Int): Long {
        val y = (if (m <= 2) y0 - 1 else y0).toLong()
        val era = y / 400
        val yoe = y - era * 400
        val mp = (m + 9) % 12
        val doy = (153 * mp + 2) / 5 + d - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    /** Days from `today` to the last day `expires`: 0 on that day, below 0 once past. */
    fun daysLeft(expires: String?, today: String = today()): Int? {
        val a = ymd(expires) ?: return null
        val b = ymd(today) ?: return null
        return (dayNumber(a.first, a.second, a.third) - dayNumber(b.first, b.second, b.third)).toInt()
    }

    /** Quiet with time left, warn in its last three days, bad once past (and still usable: plans
     *  get extended). Null without a last day. */
    fun of(expires: String?, today: String = today()): Left? {
        val days = daysLeft(expires, today) ?: return null
        return when {
            days < 0 -> Left(days, "Expired", Tone.Bad)
            days == 0 -> Left(days, "Expires today", Tone.Warn)
            days <= SOON -> Left(days, if (days == 1) "1 day left" else "$days days left", Tone.Warn)
            else -> Left(days, "$days days left", Tone.Quiet)
        }
    }

    /** "12 Nov", or "12 Nov 2027" in another year. */
    fun words(day: String?, today: String = today()): String {
        val (y, m, d) = ymd(day) ?: return day.orEmpty()
        return "$d ${MONTHS[m - 1]}" + if (ymd(today)?.first == y) "" else " $y"
    }

    /** "Its plan ended on 11 Oct. Connecting anyway." for a place past its last day, else null. */
    fun endedWords(expires: String?): String? =
        if (of(expires)?.tone == Tone.Bad) "Its plan ended on ${words(expires)}. Connecting anyway." else null
}
