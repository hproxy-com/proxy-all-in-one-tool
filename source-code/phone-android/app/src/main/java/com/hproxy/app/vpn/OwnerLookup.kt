package com.hproxy.app.vpn

import android.net.ConnectivityManager
import android.os.Build
import androidx.annotation.Keep
import androidx.annotation.RequiresApi
import java.net.InetAddress
import java.net.InetSocketAddress

/**
 * Whose connection is this? Asked by the engine's firewall for every new connection in the VPN
 * (proxy-engine/hproxy-mobile, jni_glue.rs, by this class's name). Android 10 and later answer it
 * only for the app running the VPN; older phones are read in Rust (/proc/net, owner.rs).
 */
@Keep
@RequiresApi(Build.VERSION_CODES.Q)
class OwnerLookup(private val cm: ConnectivityManager) {
    /** The app's user id, or -1 when Android cannot say. */
    @Keep
    fun uid(udp: Boolean, src: ByteArray, srcPort: Int, dst: ByteArray, dstPort: Int): Int = try {
        cm.getConnectionOwnerUid(
            if (udp) 17 else 6,
            InetSocketAddress(InetAddress.getByAddress(src), srcPort),
            InetSocketAddress(InetAddress.getByAddress(dst), dstPort),
        )
    } catch (e: Exception) {
        -1
    }
}
