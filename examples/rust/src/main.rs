//! Three requests through the rotating proxy, each going out through the next proxy.
//!
//! Start the proxy first:  hproxy connect --file proxies.txt --background
//! Then:                   cargo run

const PROXY: &str = "http://127.0.0.1:8080"; // where hproxy connect listens

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::builder()
        .proxy(reqwest::Proxy::all(PROXY)?)
        // reqwest keeps idle connections for the next request, each on its proxy. With none
        // kept, every request opens its own connection: the next proxy. Leave the pool on when
        // you want to stay on the same address.
        .pool_max_idle_per_host(0)
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    for i in 1..=3 {
        let text = client.get("https://hproxy.com/cdn-cgi/trace").send()?.text()?;
        let field = |name: &str| {
            text.lines()
                .find_map(|line| line.strip_prefix(name))
                .unwrap_or("?")
                .to_string()
        };
        println!("{i}: ip={} loc={}", field("ip="), field("loc="));
    }
    Ok(())
}
