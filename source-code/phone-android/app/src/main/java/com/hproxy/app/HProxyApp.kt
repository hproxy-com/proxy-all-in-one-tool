package com.hproxy.app

import android.app.Application
import android.net.ConnectivityManager
import android.os.Build
import com.hproxy.app.engine.Native
import com.hproxy.app.engine.Pictures
import com.hproxy.app.state.AppState
import com.hproxy.app.vpn.OwnerLookup

/** The app's process: the engine starts with it, before any screen or service. */
class HProxyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        if (Pictures.on) Pictures.load(this)
        AppState.start(this)
        // Android 10 and later tell the firewall whose connection a connection is only through
        // ConnectivityManager; older phones are read in Rust.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getSystemService(ConnectivityManager::class.java)?.let { Native.setOwnerLookup(OwnerLookup(it)) }
        }
    }
}
