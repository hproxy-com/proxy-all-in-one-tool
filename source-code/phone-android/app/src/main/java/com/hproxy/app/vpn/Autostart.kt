package com.hproxy.app.vpn

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

/**
 * Phones whose maker keeps an app from starting after the phone starts unless the person lets it
 * start by itself, in the maker's own settings (dontkillmyapp.com follows them): there "Connect when
 * the phone starts" does nothing without it. Settings says so in the maker's own word for the
 * setting, and a tap opens the maker's screen for it (the names of those screens are the ones the
 * same community keeps); without one, HProxy's own page in the phone's settings.
 */
object Autostart {
    class Maker(val name: String, val setting: String, val screens: List<ComponentName>)

    private fun c(pkg: String, cls: String) = ComponentName(pkg, cls)

    private val xiaomi = Maker("Xiaomi", "Autostart", listOf(c("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")))
    private val huawei = Maker(
        "Huawei", "App launch",
        listOf(
            c("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
            c("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"),
            c("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
        ),
    )
    private val honor = Maker("Honor", "App launch", listOf(c("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity")) + huawei.screens)
    private val colorOs = listOf(
        c("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
        c("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
        c("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
    )
    private val makers = mapOf(
        "xiaomi" to xiaomi,
        "huawei" to huawei,
        "honor" to honor,
        "oppo" to Maker("Oppo", "Auto launch", colorOs),
        "realme" to Maker("Realme", "Auto launch", colorOs),
        "oneplus" to Maker("OnePlus", "Auto launch", colorOs + c("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity")),
        "vivo" to Maker(
            "Vivo", "Autostart",
            listOf(
                c("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
                c("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
                c("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
            ),
        ),
        "meizu" to Maker("Meizu", "Auto start", emptyList()),
        "asus" to Maker("Asus", "Auto start", listOf(c("com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity"))),
    )

    /** This phone's maker, when it is one of them (Redmi and POCO phones say Xiaomi). */
    fun maker(): Maker? = makers[Build.MANUFACTURER.lowercase().trim()]

    /** The maker's screen for it, else HProxy's page in the phone's settings. A screen another
     *  version of the maker's system moved or locked just throws: the next one is tried. */
    fun open(context: Context) {
        val new = Intent.FLAG_ACTIVITY_NEW_TASK
        for (screen in maker()?.screens.orEmpty()) {
            try {
                context.startActivity(Intent().setComponent(screen).addFlags(new))
                return
            } catch (e: Exception) {
                // Not on this version of the maker's system.
            }
        }
        for (fallback in listOf(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
            Intent(Settings.ACTION_SETTINGS),
        )) {
            try {
                context.startActivity(fallback.addFlags(new))
                return
            } catch (e: Exception) {
                // A pared-down system without this screen either.
            }
        }
    }
}
