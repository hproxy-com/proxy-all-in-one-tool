package com.hproxy.checker

import android.app.Activity
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** Google Play's own package name: the installer of every copy Play installed. */
const val GOOGLE_PLAY = "com.android.vending"

/**
 * Which app installed this copy, for src-tauri/src/channel.rs: Google Play, or anything else (a
 * browser, the file manager, adb). The same Android file is published on Google Play, GitHub and
 * hproxy.com, so the app learns where it came from here, while it runs, never from how it was
 * built. Loaded by channel.rs (`register_android_plugin`).
 */
@TauriPlugin
class InstallSourcePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun installSource(invoke: Invoke) {
    invoke.resolve(JSObject().put("installer", installerOf(activity)))
  }
}

/** The package name of the app that installed this one, or null when Android does not say. */
fun installerOf(activity: Activity): String? =
  try {
    val packages = activity.packageManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      packages.getInstallSourceInfo(activity.packageName).installingPackageName
    } else {
      @Suppress("DEPRECATION")
      packages.getInstallerPackageName(activity.packageName)
    }
  } catch (_: Exception) {
    null
  }
