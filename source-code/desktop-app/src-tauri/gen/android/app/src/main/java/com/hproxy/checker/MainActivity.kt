package com.hproxy.checker

import android.app.Activity
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.UpdateAvailability

class MainActivity : TauriActivity() {
  /**
   * Google Play's in-app update, the full-screen "update now" that comes before the app is used
   * (the maintainer, 2026-09-27: "every time I open an app that has an update ... it requires me to install
   * it before I can start it"). Only for a copy Play installed: Play can update only those, and a
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

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
