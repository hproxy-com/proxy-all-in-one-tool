//! The relay as a command. `hproxy connect` in the CLI is the same code path;
//! this binary exists so the relay can be shipped and tested on its own.

use std::process::ExitCode;

use hproxy_relay::cli::{parse_args, run, USAGE};

#[tokio::main]
async fn main() -> ExitCode {
    match parse_args(std::env::args().skip(1)) {
        Ok(None) => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Ok(Some(args)) => match run(args).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("hproxy-relay: {e}");
                ExitCode::FAILURE
            }
        },
        Err(e) => {
            eprintln!("hproxy-relay: {e}\n");
            eprint!("{USAGE}");
            ExitCode::FAILURE
        }
    }
}
