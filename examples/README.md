# hproxy from any language

hproxy turns your proxies, or the free HProxy pool, into one proxy on your own machine with no
username and no password: `http://127.0.0.1:8080`, which speaks SOCKS5 on the same port. Every
language and every program that can use a proxy can use it, also the ones that cannot log in to
one (Chrome's `--proxy-server`, most scraping tools).

## Start it

```sh
hproxy connect --file proxies.txt --background     # your own list
hproxy free --country US --background              # the free HProxy pool
```

`proxies.txt` holds one proxy per line, in any shape a provider prints: `host:port:user:pass`,
`http://user:pass@host:port`, `socks5://user:pass@host:port`. `hproxy status` shows what runs,
`hproxy stop` ends it. No hproxy yet: [Download](../README.md#download).

## How it rotates

Every new connection goes out through the next proxy of your list (`--rotate every`, the
default). The other rules: `every:25` (a new proxy every 25 connections), `every:10m` (every 10
minutes), `random`, and `on-failure` (stay on one until it stops answering).

Most HTTP clients keep a connection open and send the next request over it (keep-alive), and
requests on one connection share one proxy. So each example shows how its language opens a new
connection per request, for a new IP every time, and what to keep to stay on one address.

## The examples

Each one sends three requests to `https://hproxy.com/cdn-cgi/trace` through the proxy and prints
the address and the country the site saw, one line per request.

| Language | File | Run it |
| --- | --- | --- |
| Shell | [curl.sh](curl.sh) | `sh curl.sh` |
| Python | [python/requests_example.py](python/requests_example.py) | `pip install requests`, then `python requests_example.py` |
| Python, nothing to install | [python/urllib_example.py](python/urllib_example.py) | `python urllib_example.py` |
| Node.js 20 and newer | [node/fetch.mjs](node/fetch.mjs) | `npm install`, then `node fetch.mjs` |
| Go | [go/main.go](go/main.go) | `go run main.go` |
| Rust | [rust/src/main.rs](rust/src/main.rs) | `cargo run` |
| Java 11 and newer | [java/Example.java](java/Example.java) | `java Example.java` |
| C#, .NET 8 and newer | [csharp/Program.cs](csharp/Program.cs) | `dotnet run` |
| PHP | [php/example.php](php/example.php) | `php example.php` |
| Ruby | [ruby/example.rb](ruby/example.rb) | `ruby example.rb` |
| PowerShell | [powershell/example.ps1](powershell/example.ps1) | `pwsh example.ps1` |
| Playwright | [playwright/playwright.mjs](playwright/playwright.mjs) | `npm install`, `npx playwright install chromium`, `node playwright.mjs` |
| Puppeteer | [puppeteer/puppeteer.mjs](puppeteer/puppeteer.mjs) | `npm install`, then `node puppeteer.mjs` |
| Selenium | [selenium/selenium_example.py](selenium/selenium_example.py) | `pip install selenium`, then `python selenium_example.py` |

This repository's tests run every example on each change, through two test proxies: the three
requests of each one have to come out through both of them.

## Every program at once

Most command-line tools and many libraries take the proxy from the environment:

```sh
export HTTP_PROXY=http://127.0.0.1:8080 HTTPS_PROXY=http://127.0.0.1:8080
export NO_PROXY=localhost,127.0.0.1    # this machine itself stays off the proxy
```

## In a container

The same proxy as a container: [Docker/README.md](../Docker/README.md). From another container
of the same Compose project, the address is the service's name, for example `http://hproxy:8080`.
