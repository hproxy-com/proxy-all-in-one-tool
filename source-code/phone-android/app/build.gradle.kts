import java.util.Properties
import javax.inject.Inject

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Release signing with the UPLOAD key, which Google Play checks on every upload: the same key the
// Play app com.hproxy.app was created with, so this app ships as an update of it. The keystore
// and its password live outside the repository, in a keystore.properties that git ignores: in
// this folder, or the one the earlier app read (desktop-app/src-tauri/gen/android). Without it a
// release build is unsigned. A debug or preview build is "HProxy Dev" (com.hproxy.app.dev), beside
// the Play copy, signed with the computer's own debug key; preview is the one to try on a phone.
val keystoreProperties = Properties().apply {
    val here = rootProject.file("keystore.properties")
    val earlier = rootProject.file("../desktop-app/src-tauri/gen/android/keystore.properties")
    val file = if (here.exists()) here else earlier
    if (file.exists()) file.inputStream().use { load(it) }
}
val hasReleaseKey = keystoreProperties.getProperty("storeFile") != null

/** The product's version, read where the release tool reads it. */
val appVersion: String = Regex("\"version\"\\s*:\\s*\"(\\d+\\.\\d+\\.\\d+)\"")
    .find(rootProject.file("../desktop-app/src-tauri/tauri.conf.json").readText())
    ?.groupValues?.get(1)
    ?: throw GradleException("no version in desktop-app/src-tauri/tauri.conf.json")

android {
    namespace = "com.hproxy.app"
    compileSdk = 36
    ndkVersion = "27.1.12297006"

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
        // Fixed forever when the Play app was created (2026-09-28).
        applicationId = "com.hproxy.app"
        // Android 7: old phones keep working (every newer call is behind a version check).
        minSdk = 24
        targetSdk = 36
        // One version for the whole product, every channel: desktop-app/src-tauri/tauri.conf.json,
        // which the release tool ships (release.mjs). The code as the earlier app wrote it:
        // major * 1000000 + minor * 1000 + patch (0.2.8 was 2008, 0.3.1 was 3001).
        versionName = appVersion
        versionCode = appVersion.split(".").map { it.toInt() }.let { (major, minor, patch) -> major * 1_000_000 + minor * 1000 + patch }
        // Example addresses on the screen: the pictures build only (Pictures.kt).
        buildConfigField("boolean", "PICTURES", "false")
    }

    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".dev"
            isDebuggable = true
        }
        getByName("release") {
            if (hasReleaseKey) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        // The build to try on a phone: shrunk and optimized exactly like the Play build, so the
        // animations run as fast as they will for customers (a debug build is far slower), but
        // "HProxy Dev" beside the Play copy, signed with this computer's debug key.
        create("preview") {
            initWith(getByName("release"))
            applicationIdSuffix = ".dev"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
        }
        // Store pictures and the website's films: the Play build's code and look, named "HProxy"
        // as on Play, beside it (com.hproxy.app.pictures), with only example addresses and plain
        // network names on the screen (engine/Pictures.kt). Made on this computer, never shipped.
        create("pictures") {
            initWith(getByName("release"))
            applicationIdSuffix = ".pictures"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
            buildConfigField("boolean", "PICTURES", "true")
        }
    }
    sourceSets["preview"].res.directories += "src/debug/res"

    // Java 17, and the Kotlin with it (built-in Kotlin takes its JVM target from here).
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/*.version", "DebugProbesKt.bin")
    }
}

dependencies {
    // Compose 1.7 (BOM 2024.12.01), read by the Kotlin 2.0.21 Compose compiler.
    val compose = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(compose)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // "Scan a QR code": Google's scanner, which needs no camera permission (Play services
    // shows its own camera screen and hands back only the code).
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    // Play services still names Fragment 1.0.0 (2018), whose activities hand back results the old,
    // broken way (lint stops a release build over it); this lifts it to a current one.
    implementation("androidx.fragment:fragment:1.8.5")
    debugImplementation("androidx.compose.ui:ui-tooling")
}

// ---------------------------------------------------------------------------------------------
// The engine: proxy-engine/hproxy-mobile, built by cargo for each Android chip type, its
// libhproxy_mobile.so laid out per chip type in the folder AGP gives each build of the app for
// native libraries made during the build (and packs). The NDK's compilers link it (and compile
// ring's C parts). `-Pabis=x86_64` builds one chip type only (an emulator); the default is the two
// every phone uses, `-Pabis=all` adds the two emulator ones.
// ---------------------------------------------------------------------------------------------

abstract class BuildEngine @Inject constructor(private val exec: org.gradle.process.ExecOperations) : DefaultTask() {
    @get:Input abstract val abis: ListProperty<String>
    @get:Input abstract val ndk: Property<String>
    @get:Internal abstract val workspace: DirectoryProperty
    @get:OutputDirectory abstract val out: DirectoryProperty

    private val triples = mapOf(
        "arm64-v8a" to "aarch64-linux-android",
        "armeabi-v7a" to "armv7-linux-androideabi",
        "x86_64" to "x86_64-linux-android",
        "x86" to "i686-linux-android",
    )
    private val clangs = mapOf(
        "arm64-v8a" to "aarch64-linux-android24-clang",
        "armeabi-v7a" to "armv7a-linux-androideabi24-clang",
        "x86_64" to "x86_64-linux-android24-clang",
        "x86" to "i686-linux-android24-clang",
    )

    @TaskAction
    fun build() {
        val os = System.getProperty("os.name").lowercase()
        val host = when {
            os.contains("windows") -> "windows-x86_64"
            os.contains("mac") -> "darwin-x86_64"
            else -> "linux-x86_64"
        }
        val windows = os.contains("windows")
        val bin = File(ndk.get(), "toolchains/llvm/prebuilt/$host/bin")
        val root = workspace.get().asFile
        for (abi in abis.get()) {
            val triple = triples[abi] ?: throw GradleException("unknown chip type $abi")
            val clang = File(bin, clangs.getValue(abi) + if (windows) ".cmd" else "").absolutePath
            val ar = File(bin, if (windows) "llvm-ar.exe" else "llvm-ar").absolutePath
            val key = triple.replace('-', '_')
            exec.exec {
                workingDir = root
                commandLine("cargo", "build", "-p", "hproxy-mobile", "--lib", "--profile", "phone", "--target", triple)
                environment("CARGO_TARGET_${key.uppercase()}_LINKER", clang)
                environment("CC_$key", clang)
                environment("AR_$key", ar)
            }
            val built = File(root, "target/$triple/phone/libhproxy_mobile.so")
            val into = out.get().dir(abi).asFile.apply { mkdirs() }
            built.copyTo(File(into, "libhproxy_mobile.so"), overwrite = true)
        }
    }
}

val engineAbis: List<String> = when (val asked = (findProperty("abis") as String?)?.trim()) {
    null, "" -> listOf("arm64-v8a", "armeabi-v7a")
    "all" -> listOf("arm64-v8a", "armeabi-v7a", "x86_64", "x86")
    else -> asked.split(",").map { it.trim() }.filter { it.isNotEmpty() }
}

// One task per build of the app (debug, release, preview, pictures): AGP picks each one's folder
// and runs it before packing, so nothing is tied to AGP's own task names. cargo builds a chip type
// once; a second build of the app only copies.
androidComponents {
    onVariants { variant ->
        val engine = tasks.register<BuildEngine>("buildEngine${variant.name.replaceFirstChar { it.uppercase() }}") {
            abis.set(engineAbis)
            ndk.set(androidComponents.sdkComponents.ndkDirectory.map { it.asFile.absolutePath })
            workspace.set(rootProject.layout.projectDirectory.dir(".."))
            // cargo knows when nothing changed; Gradle asks it every time.
            outputs.upToDateWhen { false }
        }
        variant.sources.jniLibs?.addGeneratedSourceDirectory(engine, BuildEngine::out)
    }
}

android.defaultConfig.ndk.abiFilters.addAll(engineAbis)
