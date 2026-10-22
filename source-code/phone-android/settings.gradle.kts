// The native phone app: Kotlin and Jetpack Compose, Android's own toolkit, on
// the Rust engine of this repository (proxy-engine/hproxy-mobile).
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
