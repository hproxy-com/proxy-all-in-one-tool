package com.hproxy.checker

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.UpdateAvailability

class MainActivity : TauriActivity() {
  /**
   * Google Play's in-app update, the full-screen "update now" that comes before the app is used,
   * the way phone apps install an update before they start. Only for a copy Play installed: Play
   * can update only those, and a
   * copy from a download gets its notice from the version list instead (src/lib/startGate.ts).
   *
   * It never traps anyone: whoever says no uses the app as it is, and is asked again at the next
   * start, not the moment the Play screen closes (that moment is a resume too). No internet, or
   * Play has nothing: nothing happens. An update that was started and interrupted is always
   * resumed, as Play asks of every app.
   */
  private val appUpdates by lazy { AppUpdateManagerFactory.create(this) }
  private var declined = false
  private val updateFlow =
    registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
      if (result.resultCode != Activity.RESULT_OK) declined = true
    }

  /**
   * The page draws edge to edge, under the status bar and the gesture bar, and leaves itself the
   * room they take (styles/phone.css). The bars' icons and the colour behind the page start as
   * the page last was (PhonePlugin.kt, PageColors), so the first frame already matches it.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    val dark = PageColors.dark(this)
    val style =
      if (dark) SystemBarStyle.dark(Color.TRANSPARENT)
      else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
    enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
    window.setBackgroundDrawable(ColorDrawable(PageColors.canvas(this)))
    super.onCreate(savedInstanceState)
  }

  /** The web view is white until the page draws: it starts in the page's colour instead. */
  override fun onWebViewCreate(webView: WebView) {
    webView.setBackgroundColor(PageColors.canvas(this))
    val major = version.substringBefore('.').toIntOrNull()
    if (major != null && major < OLDEST_WEB_VIEW) window.decorView.post { askToUpdateWebView(major) }
  }

  /**
   * The window is a web page, drawn by the phone's web view: Android System WebView, or Chrome on
   * Android 7 to 9, where Chrome draws the pages of every app. One older than the page needs
   * draws nothing at all, so instead of a blank screen Android says what to update and opens its
   * page on Google Play. Phones update their web view through Play; it costs one tap.
   */
  private fun askToUpdateWebView(major: Int) {
    val provider = if (Build.VERSION.SDK_INT >= 26) WebView.getCurrentWebViewPackage()?.packageName else null
    val pkg = provider ?: if (Build.VERSION.SDK_INT <= 28) CHROME else SYSTEM_WEB_VIEW
    val name = if (pkg == CHROME) "Chrome" else "Android System WebView"
    AlertDialog.Builder(this)
      .setTitle("Update $name")
      .setMessage(
        "HProxy draws its screens with $name, and the version on this phone ($major) is too old for " +
          "them. Update it on Google Play, then open HProxy again."
      )
      .setPositiveButton("Open Google Play") { _, _ -> openOnPlay(pkg) }
      .setNegativeButton("Close", null)
      .show()
  }

  private fun openOnPlay(pkg: String) {
    for (link in listOf("market://details?id=$pkg", "https://play.google.com/store/apps/details?id=$pkg")) {
      try {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)))
        return
      } catch (_: ActivityNotFoundException) {
        // No Play Store on this phone: the web page instead.
      }
    }
  }

  companion object {
    /** The page's styles need Chrome 111 or later (Tailwind 4: color-mix, @property, layers). */
    const val OLDEST_WEB_VIEW = 111
    const val CHROME = "com.android.chrome"
    const val SYSTEM_WEB_VIEW = "com.google.android.webview"
  }

  override fun onResume() {
    super.onResume()
    updateFromGooglePlay()
  }

  private fun updateFromGooglePlay() {
    if (installerOf(this) != GOOGLE_PLAY) return
    appUpdates.appUpdateInfo.addOnSuccessListener { info ->
      val halfway = info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS
      val waiting =
        info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE &&
          info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE) &&
          !declined
      if (halfway || waiting) {
        appUpdates.startUpdateFlowForResult(
          info,
          updateFlow,
          AppUpdateOptions.newBuilder(AppUpdateType.IMMEDIATE).build(),
        )
      }
    }
  }
}
