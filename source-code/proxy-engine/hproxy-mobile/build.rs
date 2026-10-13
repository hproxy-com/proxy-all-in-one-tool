//! Google Play takes only Android libraries laid out for 16 KB memory pages (it refused the
//! earlier app's 0.2.4 for it: "Your app does not support 16 KB memory page sizes"), and NDK r27
//! links for 4 KB. Told here, in the crate, so every Android build of the engine gets it,
//! whoever runs cargo. Harmless on 4 KB phones and on 32-bit Android, which only uses 4 KB pages.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
}
