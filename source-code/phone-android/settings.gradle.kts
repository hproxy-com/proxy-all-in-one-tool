// The native phone app (Track P, docs/plan-2026-10-03-one-account-and-app-rebuild
// in the monorepo): Kotlin and Jetpack Compose, Android's own toolkit, on the
// Rust engine of this repository (proxy-engine/hproxy-mobile).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "hproxy-phone"
include(":app")
