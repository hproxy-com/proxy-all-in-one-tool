// Kotlin 2.0 brings the Compose compiler as its own plugin; Compose 1.7 is
// read by it (the version table is in app/build.gradle.kts).
plugins {
    id("com.android.application") version "8.11.0" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}
