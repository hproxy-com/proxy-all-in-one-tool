package com.hproxy.app

import android.app.Application
import android.net.ConnectivityManager
import android.os.Build
import com.hproxy.app.engine.Native
import com.hproxy.app.engine.Pictures
import com.hproxy.app.firewall.Firewall
import com.hproxy.app.remind.Reminders
import com.hproxy.app.state.AppState
import com.hproxy.app.state.Usage
import com.hproxy.app.vpn.OwnerLookup

/** The app's process: the engine starts with it, before any screen or service. */
class HProxyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        if (Pictures.on) Pictures.load(this)
        AppState.start(this)
        // Usage counts (state/Usage.kt), only after a yes: a crash of the screens counts, and a
        // finished day that waits goes, away from the screen.
        val before = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            Usage.crashedNow()
            before?.uncaughtException(thread, e)
        }
        Thread({ Usage.sendNow() }, "hproxy-usage").start()
        // Plans close to their last day: the twice-daily look armed, and one look now.
        Reminders.arm(this)
        Thread({ Reminders.look(this) }, "hproxy-reminders").start()
        // The firewall's list of apps, read once away from the screen: the first Connect needs it,
        // and reading every app's name takes seconds on a slow phone with many apps.
        Thread({ Firewall.installed(this) }, "hproxy-apps").start()
        // Android 10 and later tell the firewall whose connection a connection is only through
        // ConnectivityManager; older phones are read in Rust.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getSystemService(ConnectivityManager::class.java)?.let { Native.setOwnerLookup(OwnerLookup(it)) }
        }
    }
}
