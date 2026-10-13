package com.hproxy.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.hproxy.app.engine.Pictures
import com.hproxy.app.migrate.OldAppStorage
import com.hproxy.app.state.AppState
import com.hproxy.app.ui.Nav
import com.hproxy.app.ui.Page
import com.hproxy.app.ui.Root
import com.hproxy.app.ui.SheetKind
import com.hproxy.app.ui.Tab
import com.hproxy.app.ui.map.World
import com.hproxy.app.vpn.HProxyVpnService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The one screen of the app, drawn by Compose (a native app, no web page inside). It asks Android for what only a screen can ask for: the VPN (its
 * own "connection request"), notifications, and the QR scanner.
 */
class MainActivity : ComponentActivity() {
    companion object {
        const val OPEN_APPS = "com.hproxy.app.OPEN_APPS"
    }

    private val nav = Nav()
    private var afterVpn: (() -> Unit)? = null

    private val vpnConsent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val then = afterVpn
        afterVpn = null
        if (result.resultCode == RESULT_OK) {
            then?.invoke()
            // Only now, one question at a time: the VPN first, then the notification it shows.
            askNotificationsOnce()
        } else {
            AppState.toast("HProxy needs Android's permission to carry your apps. Connect again and tap OK.")
        }
    }

    // A VPN that is already running made its notification before this answer, and Android keeps
    // that one hidden: shown at once on a yes, not at the next probe up to twenty seconds later.
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) HProxyVpnService.running?.refresh()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        AppState.start(applicationContext)
        nav.showShelf(if (com.hproxy.app.state.Settings.shelf == "Mine") com.hproxy.app.ui.Shelf.Mine else com.hproxy.app.ui.Shelf.Free)

        nav.askVpn = { then ->
            val ask = VpnService.prepare(this)
            if (ask == null) {
                then()
                askNotificationsOnce()
            } else {
                afterVpn = then
                vpnConsent.launch(ask)
            }
        }
        nav.askNotifications = { askNotificationsOnce(force = true) }
        nav.scan = { got -> scan(got) }

        lifecycleScope.launch {
            withContext(Dispatchers.Default) { World.load(applicationContext) }
            World.ready = true
        }
        lifecycleScope.launch { OldAppStorage.moveIfThere(this@MainActivity) }
        handle(intent)
        setContent { Root(nav) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        if (!AppState.wanted) lifecycleScope.launch { AppState.refreshOwnIp() }
    }

    /** Proxies shared from another app go to Add proxies, read and ready; a blocked app's
     *  notification opens Which apps. */
    private fun handle(intent: Intent?) {
        // The pictures build only: example addresses and the real ones behind them (Pictures.kt).
        if (Pictures.on) intent?.getStringExtra("pictures")?.let { Pictures.seed(applicationContext, it) }
        when (intent?.action) {
            Intent.ACTION_SEND -> {
                val text = intent.getStringExtra(Intent.EXTRA_TEXT)
                if (!text.isNullOrBlank()) {
                    nav.incoming = text
                    nav.go(Tab.Proxies)
                    nav.open(SheetKind.Add)
                }
            }
            OPEN_APPS -> nav.push(Page.Apps)
        }
    }

    private fun askNotificationsOnce(force: Boolean = false) {
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val sp = getSharedPreferences("hproxy", MODE_PRIVATE)
        if (!force && sp.getBoolean("askedNotifications", false)) return
        sp.edit().putBoolean("askedNotifications", true).apply()
        notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** Google's scanner: Play services shows its own camera screen and hands back only the code,
     *  so this app needs no camera permission. */
    private fun scan(got: (String) -> Unit) {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        val scanner = GmsBarcodeScanning.getClient(this, options)
        scanner.startScan()
            .addOnSuccessListener { code -> code.rawValue?.let(got) }
            .addOnFailureListener { e ->
                // The scanner is a part of Play services fetched the first time; ask for it.
                ModuleInstall.getClient(this).installModules(ModuleInstallRequest.newBuilder().addApi(scanner).build())
                AppState.toast("The scanner is getting ready. Try again in a moment. (${e.message ?: "Play services"})")
            }
    }
}
