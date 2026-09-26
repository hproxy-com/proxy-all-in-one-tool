# The engine

Four Rust crates that every HProxy tool shares: the app for Windows, macOS, Linux and Android,
the command-line tool and its MCP server.

| Crate | What it does |
| --- | --- |
| `hproxy-probe` | The checking engine: reads a proxy line in any common format, tests it over HTTP, HTTPS, SOCKS4 and SOCKS5, grades its anonymity, catches proxies that read HTTPS, and paces a whole list. No interface, no database. |
| `hproxy-relay` | The connector: a local HTTP and SOCKS5 proxy without a password that forwards through a real proxy with its login attached. One proxy, a rotating list, or the free pool. |
| `hproxy-system` | Reads, sets and restores the operating system's proxy setting. |
| `hproxy-api` | The client for hproxy.com's free services: IP locations, checking on HProxy's servers, the free proxy list, fraud scores and the version list. |
