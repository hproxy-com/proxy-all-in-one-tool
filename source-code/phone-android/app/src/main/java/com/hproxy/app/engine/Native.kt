package com.hproxy.app.engine

/**
 * The Rust engine, libhproxy_mobile.so (proxy-engine/hproxy-mobile in this repository): the
 * places, the connection, the VPN's tunnel with the firewall, and the checker.
 *
 * Every function answers JSON, `{"ok":true,"value":...}` or `{"ok":false,"error":"..."}`, and none
 * throws: Engine.kt reads the answers. `poll` waits for the next event and answers it, or null.
 */
internal object Native {
    init {
        System.loadLibrary("hproxy_mobile")
    }

    @JvmStatic external fun init(dataDir: String, sdk: Int): String

    @JvmStatic external fun call(method: String, args: String): String

    @JvmStatic external fun poll(timeoutMs: Int): String?

    /** A new VPN descriptor for a new tunnel; Rust owns it from here on. */
    @JvmStatic external fun tunnelStart(fd: Int, throughProxy: Boolean): String

    /** A new VPN descriptor for the running tunnel (only the apps in the VPN changed). */
    @JvmStatic external fun tunnelSwap(fd: Int): String

    @JvmStatic external fun tunnelStop(): String

    /** Android 10 and later: who tells the firewall which app owns a connection. */
    @JvmStatic external fun setOwnerLookup(lookup: Any): String
}
