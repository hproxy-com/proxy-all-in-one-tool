import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing with the UPLOAD key, which Google Play checks on every
// upload. The keystore and its password live OUTSIDE the repository, in
// `gen/android/keystore.properties` (ignored by git), on the maintainers'
// computer only. Without the file a release build is unsigned. Play signs what
// it publishes with Google's own key, and the public APK is Google's signed one
// (scripts/android-play.mjs): an APK signed with this key never goes public,
// because Play's copies could not update it. If the key were lost, Play resets
// it through support with the account owner's proof.
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
val hasReleaseKey = keystoreProperties.getProperty("storeFile") != null

android {
    compileSdk = 36
    namespace = "com.hproxy.checker"
    if (hasReleaseKey) {
        signingConfigs {
            create("release") {
                keyAlias = keystoreProperties.getProperty("keyAlias", "upload")
                keyPassword = keystoreProperties.getProperty("password")
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("password")
            }
        }
    }
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        // The app's name on Google Play and on the phone, fixed for good when the Play app was
        // created (2026-09-28): it can never change. Only this line says it. `namespace` above
        // stays com.hproxy.checker: it is the package of the Kotlin code (MainActivity.kt,
        // InstallSourcePlugin.kt, the classes Tauri generates, the plugin name in channel.rs),
        // and the desktop app keeps com.hproxy.checker as its identifier, because that names
        // every Windows user's data folder.
        applicationId = "com.hproxy.app"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (hasReleaseKey) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // Google Play's in-app update: a copy Play installed takes a new version before it is used
    // (MainActivity.kt). It talks to the Play Store app on the phone; no other service.
    implementation("com.google.android.play:app-update:2.1.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")