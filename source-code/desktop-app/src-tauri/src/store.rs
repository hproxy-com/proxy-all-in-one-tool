//! A copy installed from the Microsoft Store: an MSIX package (store/microsoft-store/msix/).
//!
//! Windows gives a packaged app a private copy of the per-user registry and of new files in
//! AppData, so three things work differently in that copy:
//!   - updates come from the Store, never from hproxy.com (src/lib/updater.ts asks
//!     `store_install` and does not look);
//!   - the AI tool is the package's `hproxy` command, which Windows puts on the PATH itself,
//!     not a copy in AppData with its folder added to the PATH (src/tool.rs);
//!   - "Start with the computer" would write the Run key into the private copy, where Windows
//!     never looks for it, so Settings does not offer it.
//!
//! The system proxy is not among them: the package declares the Internet Settings key
//! unvirtualized, so Connect's writes reach Windows (engine/hproxy-system).

/// Whether this process runs from an app package.
#[cfg(windows)]
pub fn is_store_install() -> bool {
    use windows_sys::Win32::Foundation::APPMODEL_ERROR_NO_PACKAGE;
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    let mut length = 0u32;
    // Asked with no buffer, a packaged process answers "the buffer is too small" and any
    // other process APPMODEL_ERROR_NO_PACKAGE.
    // SAFETY: a length of 0 with a null buffer is the documented way to ask for the length;
    // nothing is written through the null pointer.
    let answer = unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) };
    answer != APPMODEL_ERROR_NO_PACKAGE
}

#[cfg(not(windows))]
pub fn is_store_install() -> bool {
    false
}

/// For the window: the Store copy does not look for updates and does not offer starting with
/// the computer.
#[tauri::command]
pub fn store_install() -> bool {
    is_store_install()
}

#[cfg(test)]
mod tests {
    /// A test runs as a plain program, never from a package.
    #[test]
    fn a_plain_program_is_not_a_store_install() {
        assert!(!super::is_store_install());
    }
}
