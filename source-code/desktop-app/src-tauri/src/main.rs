// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The app is also the command-line tool: started with a command (`mcp`,
    // `check`, `connect` ...), or with any word at all when the program is
    // named `hproxy` (the copy an assistant runs), it runs that and opens no
    // window; only nothing or `--background` opens the app (hproxy_cli::
    // runs_as_tool). This is how an AI assistant starts it (Use with AI), and
    // how a background connection the tool starts comes back up. It happens
    // before anything of the window starts, so the one-copy-at-a-time rule
    // never sees it.
    let args: Vec<String> = std::env::args().skip(1).collect();
    // The uninstaller's call, before anything else: take the AI tool's folder off
    // the user's PATH (src/tool.rs) and end. No window, no tool.
    #[cfg(windows)]
    if args.len() == 2 && args[0] == hproxy_checker_lib::FORGET_TOOL_PATH {
        std::process::exit(hproxy_checker_lib::forget_tool_path(&args[1]));
    }
    let program = std::env::current_exe().unwrap_or_default();
    if hproxy_cli::runs_as_tool(&program, &args) {
        #[cfg(windows)]
        hproxy_cli::attach_parent_console();
        // `app` (the assistant's wake-up) starts this very program, unless this
        // is the assistant's copy: that one finds the app through the note
        // beside it (src/tool.rs).
        let is_the_copy = program.file_stem().is_some_and(|s| s.eq_ignore_ascii_case("hproxy"));
        if !is_the_copy {
            hproxy_cli::set_inside_app();
        }
        std::process::exit(i32::from(hproxy_cli::run(args)));
    }
    hproxy_checker_lib::run()
}

#[cfg(test)]
mod tests {
    /// The app's program must never be taken for the tool. A program named `hproxy`, in any
    /// case, runs as the command-line tool and never opens a window, so since the product
    /// became "HProxy" (2026-09-24) the program keeps its file name, pinned in tauri.conf.json
    /// as mainBinaryName. Renaming it to "HProxy" would ship an app that cannot open.
    #[test]
    fn the_app_program_is_never_taken_for_the_tool() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let name = conf["mainBinaryName"]
            .as_str()
            .expect("mainBinaryName is pinned in tauri.conf.json");
        for program in [
            format!(r"C:\Users\x\AppData\Local\HProxy\{name}.exe"),
            format!("/Applications/HProxy.app/Contents/MacOS/{name}"),
            format!("/usr/bin/{name}"),
        ] {
            assert!(
                !hproxy_cli::runs_as_tool(std::path::Path::new(&program), &[]),
                "{program} would run as the tool and never open a window"
            );
        }
    }

    /// The version lives in the workspace's Cargo.toml (the release tool reads it there), and
    /// tauri.conf.json repeats it because the Android build takes its version from that file
    /// alone: without it, Play got version code 1 and version name "1.0" (2026-09-24). This
    /// keeps the two equal; raise both together.
    #[test]
    fn the_config_carries_the_workspace_version() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["version"].as_str(),
            Some(env!("CARGO_PKG_VERSION")),
            "tauri.conf.json \"version\" must equal [workspace.package] version in Cargo.toml"
        );
    }
}
