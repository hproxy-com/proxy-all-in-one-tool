//! The HProxy public API, as a client: the doors on hproxy.com that need no key.
//!
//!   geo        `https://hproxy.com/api/ip`: country, city, ASN and network for
//!              addresses, in batches of up to 100.
//!   check_api  `https://hproxy.com/api/free-proxy/check`: checking on our
//!              servers instead of the user's own line, streamed back as NDJSON.
//!   free_list  `https://hproxy.com/api/proxy-list`: the live free proxy list.
//!   fraud      the fraud score of an address: FFraud's free public lookup by
//!              default, or the person's own key at another service.
//!   versions   `https://hproxy.com/downloads/versions.json`: the newest version
//!              of each product and the oldest one still supported.
//!
//! The checking itself (every transport, the judge ladder, the grading and the
//! adaptive governor) lives in `hproxy-probe`. This crate only talks to our
//! website, so the desktop app, the CLI and its MCP server read one client and
//! can never disagree about what a door answers.

pub mod check_api;
pub mod fraud;
pub mod free_list;
pub mod geo;
pub mod versions;

/// The HTTP client type the functions here take, so callers can hold one
/// without depending on the HTTP library themselves.
pub use reqwest::Client as HttpClient;

/// One HTTP client for our doors, named after the program that uses it so the
/// server logs tell the desktop app, the CLI and the MCP server apart.
/// `timeout` bounds every request: a lookup that only decorates rows gets a
/// short one, a list download a longer one.
pub fn http_client(program: &str, timeout: std::time::Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(format!("{program}/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
}
