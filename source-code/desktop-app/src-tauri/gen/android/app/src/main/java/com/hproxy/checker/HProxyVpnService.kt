package com.hproxy.checker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log

/**
 * The phone's VPN: every app's traffic comes here as packets. The packets themselves are read in
 * Rust (proxy-engine/hproxy-tunnel), which gets the VPN's file descriptor and owns it from then on:
 * this service opens the VPN, keeps the notification (Next IP, Disconnect), and closes when told.
 *
 * Started by VpnPlugin.kt when the window connects; the routes, addresses and DNS server come from
 * Rust (desktop-app/src-tauri/src/vpn.rs), so one place decides them.
 */
class HProxyVpnService : VpnService() {
  companion object {
    private const val TAG = "HProxyVpn"
    const val ACTION_START = "com.hproxy.app.vpn.START"
    const val ACTION_STOP = "com.hproxy.app.vpn.STOP"
    const val ACTION_NEXT_IP = "com.hproxy.app.vpn.NEXT_IP"
    const val ACTION_DISCONNECT = "com.hproxy.app.vpn.DISCONNECT"
    const val ACTION_UPDATE = "com.hproxy.app.vpn.UPDATE"
    const val EXTRA_ROUTES = "routes"
    const val EXTRA_ADDRESSES = "addresses"
    const val EXTRA_DNS = "dns"
    const val EXTRA_MTU = "mtu"
    const val EXTRA_THROUGH = "through"
    private const val CHANNEL = "connection"
    private const val NOTIFICATION_ID = 1

    /** The running service, while the VPN is up. */
    @Volatile var running: HProxyVpnService? = null
      private set

    /** Told once with the VPN's descriptor, or with null and the reason it did not open. */
    @Volatile var onEstablished: ((Int?, String?) -> Unit)? = null
  }

  private var through: String = ""

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> start(intent)
      ACTION_UPDATE -> {
        through = intent.getStringExtra(EXTRA_THROUGH) ?: through
        if (running != null) notify(notification())
      }
      ACTION_NEXT_IP -> HProxyNative.nextIpSafely()
      ACTION_DISCONNECT -> HProxyNative.disconnectSafely()
      ACTION_STOP -> close()
      // Started by Android itself (an always-on VPN set in the phone's settings) with no app
      // to connect through: nothing to carry, so it closes at once rather than hold the
      // phone's traffic.
      else -> if (running == null) stopSelf()
    }
    return START_NOT_STICKY
  }

  private fun start(intent: Intent) {
    val answer = onEstablished
    onEstablished = null
    through = intent.getStringExtra(EXTRA_THROUGH) ?: ""
    val fd =
      try {
        open(intent)
      } catch (e: Exception) {
        Log.e(TAG, "the VPN could not be opened", e)
        answer?.invoke(null, e.message ?: "the VPN could not be opened")
        stopSelf()
        return
      }
    if (fd == null) {
      // establish() answers null when the app is no longer allowed to run a VPN
      // (another VPN app took over, or permission was taken back).
      answer?.invoke(null, "Android did not let HProxy open the VPN. Connect again to allow it.")
      stopSelf()
      return
    }
    running = this
    showNotification()
    answer?.invoke(fd.detachFd(), null)
  }

  /** The VPN itself; null when Android refuses it. */
  private fun open(intent: Intent): ParcelFileDescriptor? {
    val builder = Builder().setSession("HProxy").setMtu(intent.getIntExtra(EXTRA_MTU, 1500))
    for (a in intent.getStringArrayExtra(EXTRA_ADDRESSES).orEmpty()) {
      val (ip, len) = a.split("/")
      builder.addAddress(ip, len.toInt())
    }
    for (r in intent.getStringArrayExtra(EXTRA_ROUTES).orEmpty()) {
      val (ip, len) = r.split("/")
      builder.addRoute(ip, len.toInt())
    }
    intent.getStringExtra(EXTRA_DNS)?.let { builder.addDnsServer(it) }
    // This app stays outside its own VPN: its relay reaches the real proxy directly.
    builder.addDisallowedApplication(packageName)
    // Tapping HProxy in the phone's VPN settings opens the app.
    builder.setConfigureIntent(openApp())
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // Apps judge the connection by the network under it (Wi-Fi is not metered), as without a VPN.
      builder.setMetered(false)
    }
    return builder.establish()
  }

  /** The VPN ends: Rust has closed the descriptor already (or never had it). */
  private fun close() {
    running = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION") stopForeground(true)
    }
    stopSelf()
  }

  /** Another VPN app took over, or the person turned HProxy off in the phone's settings. */
  override fun onRevoke() {
    HProxyNative.revokedSafely()
    close()
  }

  override fun onDestroy() {
    if (running === this) running = null
    super.onDestroy()
  }

  /**
   * The notification while connected. Android 14 and later want to know why a service stays in
   * front: an active VPN is one of the "system exempted" reasons, so it is said only once the VPN
   * is open. Without permission to show notifications (Android 13 asks) the VPN works the same;
   * Android shows its own key icon.
   */
  private fun showNotification() {
    try {
      if (Build.VERSION.SDK_INT >= 34) {
        startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
      } else {
        startForeground(NOTIFICATION_ID, notification())
      }
    } catch (e: Exception) {
      // The VPN is open and carries traffic either way: Android keeps a VPN's service running.
      Log.w(TAG, "the connection notification could not be shown", e)
    }
  }

  private fun notify(n: Notification) {
    try {
      (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, n)
    } catch (e: SecurityException) {
      Log.w(TAG, "no permission to update the notification", e)
    }
  }

  private fun notification(): Notification {
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL) == null) {
          val channel = NotificationChannel(CHANNEL, "Connection", NotificationManager.IMPORTANCE_LOW)
          channel.description = "Shows while HProxy connects this phone, with Next IP and Disconnect."
          channel.setShowBadge(false)
          manager.createNotificationChannel(channel)
        }
        Notification.Builder(this, CHANNEL)
      } else {
        @Suppress("DEPRECATION") Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
      }
    return builder
      .setSmallIcon(R.drawable.ic_connected)
      .setContentTitle("Connected through HProxy")
      .setContentText(through.ifEmpty { "Every app goes through your proxy" })
      .setContentIntent(openApp())
      .setOngoing(true)
      .setShowWhen(false)
      .addAction(action("Next IP", ACTION_NEXT_IP, 1))
      .addAction(action("Disconnect", ACTION_DISCONNECT, 2))
      .build()
  }

  @Suppress("DEPRECATION")
  private fun action(title: String, what: String, code: Int): Notification.Action {
    val intent = Intent(this, HProxyVpnService::class.java).setAction(what)
    val pending = PendingIntent.getService(this, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return Notification.Action.Builder(null, title, pending).build()
  }

  private fun openApp(): PendingIntent {
    val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
}
