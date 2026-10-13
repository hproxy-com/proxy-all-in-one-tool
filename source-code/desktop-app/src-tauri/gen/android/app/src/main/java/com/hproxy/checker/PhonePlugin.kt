package com.hproxy.checker

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class ColorsArgs {
  var dark: Boolean = true
  var canvas: String = ""
}

@InvokeArg
class BuzzArgs {
  var kind: String = "tick"
}

/**
 * The phone's own controls, for the window (src-tauri/src/phone.rs): the colour of the status
 * bar's icons, a short buzz under the finger, the room the system bars take over the page, and
 * going to the background on Back. Loaded by phone.rs (`register_android_plugin`).
 *
 * The page draws under the status bar and the gesture bar (MainActivity's edge to edge), so the
 * icons up there must contrast with the PAGE, which only the page knows: dark or white is the
 * app's own setting, not the phone's.
 */
@TauriPlugin
class PhonePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun colors(invoke: Invoke) {
    val args = invoke.parseArgs(ColorsArgs::class.java)
    val canvas = parseColor(args.canvas)
    PageColors.remember(activity, args.dark, canvas)
    activity.runOnUiThread {
      PageColors.applyBars(activity, args.dark)
      // Android's start screen, shown before the app runs at all: from Android 13 on it can be
      // told the theme for the next starts. Before that it stays dark, the app's default.
      if (Build.VERSION.SDK_INT >= 33) {
        activity.splashScreen.setSplashScreenTheme(
          if (args.dark) R.style.Theme_hproxy_checker else R.style.Theme_hproxy_checker_Light
        )
      }
    }
    invoke.resolve()
  }

  /**
   * `performHapticFeedback` needs no permission and follows the phone's own touch feedback
   * setting: with it off, nothing is felt.
   */
  @Command
  fun buzz(invoke: Invoke) {
    val kind = invoke.parseArgs(BuzzArgs::class.java).kind
    val effect =
      when (kind) {
        "press" ->
          if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.TOGGLE_ON
          else HapticFeedbackConstants.VIRTUAL_KEY
        "confirm" ->
          if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM
          else HapticFeedbackConstants.VIRTUAL_KEY
        "reject" ->
          if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT
          else HapticFeedbackConstants.LONG_PRESS
        else ->
          if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.SEGMENT_TICK
          else HapticFeedbackConstants.CLOCK_TICK
      }
    activity.runOnUiThread { activity.window.decorView.performHapticFeedback(effect) }
    invoke.resolve()
  }

  /** What the status bar, the navigation bar and a camera cutout cover, in CSS pixels. */
  @Command
  fun insets(invoke: Invoke) {
    activity.runOnUiThread {
      val all = ViewCompat.getRootWindowInsets(activity.window.decorView)
      if (all == null) {
        invoke.resolve()
        return@runOnUiThread
      }
      val bars =
        all.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val density = activity.resources.displayMetrics.density
      invoke.resolve(
        JSObject()
          .put("top", bars.top / density.toDouble())
          .put("right", bars.right / density.toDouble())
          .put("bottom", bars.bottom / density.toDouble())
          .put("left", bars.left / density.toDouble())
      )
    }
  }

  /** Like Home: the app and its connection keep running, and come back as they were. */
  @Command
  fun toBackground(invoke: Invoke) {
    activity.runOnUiThread { activity.moveTaskToBack(true) }
    invoke.resolve()
  }

  private fun parseColor(hex: String): Int? =
    try {
      if (Regex("#[0-9a-fA-F]{6}").matches(hex)) Color.parseColor(hex) else null
    } catch (_: IllegalArgumentException) {
      null
    }
}

/**
 * The page's colours, kept for the next start: before the page has drawn, the phone shows the
 * window behind it and the status bar over it, and both must already match the page, or the app
 * flashes white and the clock disappears for a moment. Dark until the page says otherwise, as the
 * app is.
 */
object PageColors {
  private const val PREFS = "page-colors"
  private const val DARK = "dark"
  private const val CANVAS = "canvas"
  /** The dark page's colour (styles/globals.css, Graphite). */
  const val DARK_CANVAS = 0xFF0C0C0F.toInt()
  /** The white page's colour (styles/globals.css, Soft). */
  const val LIGHT_CANVAS = 0xFFF0F1F4.toInt()

  fun dark(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(DARK, true)

  fun canvas(context: Context): Int {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val fallback = if (dark(context)) DARK_CANVAS else LIGHT_CANVAS
    return if (prefs.contains(CANVAS)) prefs.getInt(CANVAS, fallback) else fallback
  }

  fun remember(context: Context, dark: Boolean, canvas: Int?) {
    val edit = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(DARK, dark)
    if (canvas != null) edit.putInt(CANVAS, canvas) else edit.remove(CANVAS)
    edit.apply()
  }

  /** Light icons on a dark page, dark icons on a white one, up top and along the bottom. */
  fun applyBars(activity: Activity, dark: Boolean) {
    val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
    controller.isAppearanceLightStatusBars = !dark
    controller.isAppearanceLightNavigationBars = !dark
  }
}
