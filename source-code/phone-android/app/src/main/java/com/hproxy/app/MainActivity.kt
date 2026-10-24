package com.hproxy.app

import android.Manifest
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.hproxy.app.engine.Pictures
import com.hproxy.app.migrate.OldAppStorage
import com.hproxy.app.remind.Reminders
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
    private var afterNotifications: (() -> Unit)? = null

    private val vpnConsent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val then = afterVpn
        afterVpn = null
        if (result.resultCode == RESULT_OK) {
            // One question at a time: the VPN first, then the notification it shows, then the
            // connection, so nothing is being proven while a question covers the app.
            askNotificationsOnce(then = then)
        } else {
            AppState.toast("HProxy needs Android's permission to carry your apps. Connect again and tap OK.")
        }
    }

    // A VPN that is already running (the question asked from Settings) made its notification before
    // this answer, and Android keeps that one hidden: shown at once on a yes, not at the next probe up
    // to twenty seconds later. Then the connection that waited for the answer starts, yes or no.
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) HProxyVpnService.running?.refresh()
        val then = afterNotifications
        afterNotifications = null
        then?.invoke()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Edge to edge from Android 7 on: the screens draw under the status bar and the nav bar and
        // keep clear of them themselves. The bars' colours, their light icons and the camera cutout
        // come from the theme (res/values*/themes.xml), so no window call Android 15 retired is
        // made (Google Play lists those).
        WindowCompat.setDecorFitsSystemWindows(window, false)
        super.onCreate(savedInstanceState)
        followScreen(resources.configuration)
        AppState.start(applicationContext)
        // The usage counts' answer for the screens, and an opening (never a turn of the phone).
        com.hproxy.app.state.Usage.load()
        if (savedInstanceState == null) com.hproxy.app.state.Usage.opened()
        nav.showShelf(if (com.hproxy.app.state.Settings.shelf == "Mine") com.hproxy.app.ui.Shelf.Mine else com.hproxy.app.ui.Shelf.Free)

        nav.askVpn = ask@{ then ->
            // A few phones throw here, or lack Android's own VPN permission screen
            // (com.android.vpndialogs, missing on some TV boxes and pared-down ROMs): a word, not a crash.
            val consent = try {
                VpnService.prepare(this)
            } catch (e: Exception) {
                return@ask noVpn(e)
            }
            if (consent == null) {
                askNotificationsOnce(then = then)
                return@ask
            }
            afterVpn = then
            try {
                vpnConsent.launch(consent)
            } catch (e: Exception) {
                afterVpn = null
                noVpn(e)
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

    // A foldable opening or closing, a window resized: the screen stays, only the size changes.
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        followScreen(newConfig)
    }

    /** Upright on a phone, which the screens are drawn for; any way round on a tablet or an open
     *  foldable (its shorter side 600 dp or more), where the app keeps a phone's width in the
     *  middle (ui/Root.kt). Android 16 turns big screens whatever an app asks. */
    private fun followScreen(config: Configuration) {
        val want = if (config.smallestScreenWidthDp < 600) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        if (requestedOrientation != want) requestedOrientation = want
    }

    override fun onResume() {
        super.onResume()
        if (!AppState.wanted) lifecycleScope.launch { AppState.refreshOwnIp() }
    }

    /** Proxies shared from another app go to Add proxies, read and ready; a blocked app's
     *  notification opens Which apps; a reminder of a plan's last day, My proxies. */
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
            Reminders.OPEN_PROXIES -> {
                nav.go(Tab.Proxies)
                nav.showShelf(com.hproxy.app.ui.Shelf.Mine)
            }
        }
    }

    private fun noVpn(e: Exception) {
        Log.w("HProxy", "the VPN permission could not be asked for", e)
        AppState.toast("This phone does not let apps open a VPN, so HProxy cannot connect it.")
    }

    /** Android 13 and later ask before an app's notifications show: once, right before the first
     *  connection (from Settings again, `force`). `then` runs when the question is answered, or at
     *  once when there is nothing to ask. Until 0.4.5 the connection started first and was proven
     *  under this question: left open some twenty seconds, the proxy "didn't answer". */
    private fun askNotificationsOnce(force: Boolean = false, then: (() -> Unit)? = null) {
        val sp = getSharedPreferences("hproxy", MODE_PRIVATE)
        val ask = Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            (force || !sp.getBoolean("askedNotifications", false))
        if (!ask) {
            then?.invoke()
            return
        }
        sp.edit().putBoolean("askedNotifications", true).apply()
        afterNotifications = then
        try {
            notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        } catch (e: Exception) {
            afterNotifications = null
            then?.invoke()
        }
    }

    /** Google's scanner: Play services shows its own camera screen and hands back only the code,
     *  so this app needs no camera permission. */
    private fun scan(got: (String) -> Unit) {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        val scanner = GmsBarcodeScanning.getClient(this, options)
        scanner.startScan()
            .addOnSuccessListener { code -> code.rawValue?.let(got) }
            .addOnFailureListener { e ->
                // Phones sold without Google (some Huawei, some tablets) have no scanner to fetch.
                if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this) != ConnectionResult.SUCCESS) {
                    AppState.toast("Scanning needs Google Play services on this phone. Paste the proxies instead.")
                    return@addOnFailureListener
                }
                // The scanner is a part of Play services fetched the first time; ask for it.
                ModuleInstall.getClient(this).installModules(ModuleInstallRequest.newBuilder().addApi(scanner).build())
                AppState.toast("The scanner is getting ready. Try again in a moment. (${e.message ?: "Play services"})")
            }
    }
}
