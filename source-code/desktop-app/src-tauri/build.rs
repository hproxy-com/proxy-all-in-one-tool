fn main() {
    // Google Play refuses native code that only runs with 4 KB memory pages: phones from Android
    // 15 on can use 16 KB pages, and a library laid out for 4 KB does not load there (Play Console,
    // "Your app does not support 16 KB memory page sizes", 2026-09-28). NDK r27 still links for
    // 4 KB, so the library's LOAD segments are aligned to 16 KB here. It is a build-script link
    // argument on purpose: the Tauri CLI sets RUSTFLAGS for Android builds, which would silently
    // replace a `target.<triple>.rustflags` entry in .cargo/config.toml. Harmless on 4 KB phones,
    // and on 32-bit Android, which only ever uses 4 KB pages.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
