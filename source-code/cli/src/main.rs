//! `hproxy`, the command-line tool. Everything is in the library (lib.rs),
//! which the desktop app includes as well.

fn main() -> std::process::ExitCode {
    std::process::ExitCode::from(hproxy_cli::run(std::env::args().skip(1).collect()))
}
