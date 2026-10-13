//! The engine's log lines in Android's log (`adb logcat -s HProxy`), where
//! the rest of the app writes too. Off a phone nothing is written.

#[cfg(target_os = "android")]
mod android {
    use std::ffi::{c_char, c_int, CString};

    #[link(name = "log")]
    extern "C" {
        fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
    }

    pub struct Logcat;

    impl log::Log for Logcat {
        fn enabled(&self, m: &log::Metadata) -> bool {
            m.level() <= log::max_level()
        }

        fn log(&self, r: &log::Record) {
            if !self.enabled(r.metadata()) {
                return;
            }
            let prio = match r.level() {
                log::Level::Error => 6,
                log::Level::Warn => 5,
                log::Level::Info => 4,
                log::Level::Debug => 3,
                log::Level::Trace => 2,
            };
            let line = format!("{}: {}", r.target(), r.args()).replace('\0', " ");
            let (Ok(tag), Ok(text)) = (CString::new("HProxy"), CString::new(line)) else {
                return;
            };
            // SAFETY: two NUL-terminated strings that live through the call.
            unsafe {
                __android_log_write(prio, tag.as_ptr(), text.as_ptr());
            }
        }

        fn flush(&self) {}
    }

    pub static LOGCAT: Logcat = Logcat;
}

/// Send the engine's log to Android's, once.
pub fn start() {
    #[cfg(target_os = "android")]
    if log::set_logger(&android::LOGCAT).is_ok() {
        log::set_max_level(if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        });
    }
}
