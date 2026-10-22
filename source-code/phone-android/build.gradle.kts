// AGP 9 compiles the Kotlin itself (built-in Kotlin, Kotlin 2.2.10, the version AGP 9.4 brings),
// so there is no Kotlin plugin of its own here. The Compose compiler is still its own plugin, at
// that same Kotlin version; Compose 1.7 is read by it (the version table is in app/build.gradle.kts).
plugins {
    id("com.android.application") version "9.4.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.10" apply false
}
