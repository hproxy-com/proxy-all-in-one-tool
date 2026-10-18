package com.hproxy.app.remind

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.hproxy.app.MainActivity
import com.hproxy.app.R
import com.hproxy.app.engine.Engine
import com.hproxy.app.engine.EngineError
import com.hproxy.app.engine.Expiry
import com.hproxy.app.engine.jsonOf
import org.json.JSONArray

/**
 * Reminders: saved proxies and groups close to their last day say so on Android's notifications,
 * three days before and on the day itself, so a plan never ends unnoticed. What is due and its
 * words come from the library (proxy-engine/hproxy-places, reminders.rs: the same on every HProxy
 * app) through the engine's remindersDue; each is said once, as remindersSaid keeps beside the
 * library.
 *
 * Looked at twice a day by an inexact alarm (no exact-alarm permission: a reminder may come a few
 * hours late, never early) and at every start of the app. With notifications not allowed nothing
 * is said and nothing is marked said: the row's chip and the line over the list say it meanwhile.
 */
object Reminders {
    private const val TAG = "HProxy"
    private const val CHANNEL = "plans"

    /** A reminder's tap: My proxies (MainActivity). */
    const val OPEN_PROXIES = "com.hproxy.app.OPEN_PROXIES"

    /** The twice-daily look, armed once: one armed already keeps its time (a start of the app
     *  pushes nothing back). Android forgets it when the phone restarts; the first start after
     *  that arms it again. */
    fun arm(context: Context) {
        val intent = Intent(context, RemindersReceiver::class.java)
        if (PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE) != null) return
        val pending = PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val alarms = context.getSystemService(AlarmManager::class.java) ?: return
        alarms.setInexactRepeating(AlarmManager.RTC, System.currentTimeMillis() + AlarmManager.INTERVAL_HOUR, AlarmManager.INTERVAL_HALF_DAY, pending)
    }

    /** Show what is due today. It reads a file: never on the screen's thread. */
    fun look(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (!nm.areNotificationsEnabled()) return
        val today = Expiry.today()
        val due = try {
            Engine.callNow("remindersDue", jsonOf("today" to today)) as? JSONArray
        } catch (e: EngineError) {
            Log.w(TAG, "reminders: ${e.message}")
            null
        } ?: return
        if (due.length() == 0) return
        channel(nm)
        val said = JSONArray()
        for (i in 0 until due.length()) {
            val n = due.optJSONObject(i) ?: continue
            val key = n.optString("key")
            try {
                // One per batch: the same batch said again replaces its own.
                nm.notify(key.hashCode(), notification(context, n.optString("title"), n.optString("body")))
                said.put(key)
            } catch (e: SecurityException) {
                Log.w(TAG, "reminders: not allowed to show one", e)
            }
        }
        if (said.length() == 0) return
        try {
            Engine.callNow("remindersSaid", jsonOf("today" to today, "keys" to said))
        } catch (e: EngineError) {
            Log.w(TAG, "reminders: what was said is not kept: ${e.message}")
        }
    }

    private fun channel(nm: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || nm.getNotificationChannel(CHANNEL) != null) return
        val ch = NotificationChannel(CHANNEL, "Plans ending", NotificationManager.IMPORTANCE_DEFAULT)
        ch.description = "Says when your saved proxies are three days from their last day, and on the day."
        nm.createNotificationChannel(ch)
    }

    private fun notification(context: Context, title: String, body: String): Notification {
        val open = PendingIntent.getActivity(
            context,
            1,
            Intent(context, MainActivity::class.java).setAction(OPEN_PROXIES).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(context)
        }
        return builder
            .setSmallIcon(R.drawable.ic_connected)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setColor(0xFF0158FF.toInt())
            .build()
    }
}

/** The alarm's look, on a thread of its own (a receiver may not block the main one). */
class RemindersReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        val done = goAsync()
        Thread({
            try {
                Reminders.look(app)
            } finally {
                done.finish()
            }
        }, "hproxy-reminders").start()
    }
}
