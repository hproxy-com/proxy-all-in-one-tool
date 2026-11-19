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
| Python, httpx | [python/httpx_example.py](python/httpx_example.py) | `pip install httpx`, then `python httpx_example.py` |
| Python, aiohttp | [python/aiohttp_example.py](python/aiohttp_example.py) | `pip install aiohttp`, then `python aiohttp_example.py` |
| Scrapy | [python/scrapy_example.py](python/scrapy_example.py) | `pip install "scrapy>=2.13"`, then `python scrapy_example.py` |
| Playwright for Python | [playwright/playwright_example.py](playwright/playwright_example.py) | `pip install playwright`, `playwright install chromium`, `python playwright_example.py` |
| Node.js, axios | [node/axios.mjs](node/axios.mjs) | `npm install`, then `node axios.mjs` |
| Node.js, got | [node/got.mjs](node/got.mjs) | `npm install`, then `node got.mjs` |
| Crawlee | [crawlee/crawlee.mjs](crawlee/crawlee.mjs) | `npm install`, then `node crawlee.mjs` |
| Deno | [deno/example.ts](deno/example.ts) | `deno run --allow-net example.ts` |
| Bun | [bun/example.ts](bun/example.ts) | `bun example.ts` |
| Kotlin and Java, OkHttp | [kotlin/example.main.kts](kotlin/example.main.kts) | `kotlin example.main.kts` |
| Swift, macOS | [swift/example.swift](swift/example.swift) | `swift example.swift` |
| C and C++, libcurl | [c/example.c](c/example.c) | `cc example.c -lcurl -o example && ./example` |
| Perl | [perl/example.pl](perl/example.pl) | `perl example.pl` |
| R | [r/example.R](r/example.R) | `Rscript example.R` |
| PHP, Guzzle | [php/guzzle/example.php](php/guzzle/example.php) | `composer install`, then `php example.php` |
| Go, Colly | [go/colly/main.go](go/colly/main.go) | `go mod tidy`, then `go run .` |
| wget, aria2, HTTPie, git, pip, npm | [tools/tools.sh](tools/tools.sh) | `sh tools.sh` |

Browsers, the whole computer, phones and apps with a proxy field of their own:
[tools/README.md](tools/README.md).

This repository's tests run every example on each change, through two test proxies: the three
requests of each one have to come out through both of them (Swift on a Mac, the rest on Linux).

## A new IP when your script decides

Started with `--rotate on-failure`, the proxy stays on one proxy until something asks for the next
one. Your script asks over plain HTTP, on the proxy's own port, from any language, with nothing to
install (hproxy 0.4.9 and newer):

```sh
curl -X POST http://127.0.0.1:8080/hproxy/new-ip           # the next proxy of your list
curl -X POST "http://127.0.0.1:8080/hproxy/new-ip?member=3"   # proxy 3
curl http://127.0.0.1:8080/hproxy/status                     # the one in use, and the counts
```

Every answer is one line of JSON with `ok`, and `error` when it is false. The connections that were
open end with the switch, so the next request goes out the new way, also over a kept-alive
connection. [new-ip/](new-ip/) has the same in Python, Node.js, Go and PowerShell, and the terminal
has `hproxy new-ip`.

## Every program at once

Most command-line tools and many libraries take the proxy from the environment:

```sh
export HTTP_PROXY=http://127.0.0.1:8080 HTTPS_PROXY=http://127.0.0.1:8080
export NO_PROXY=localhost,127.0.0.1    # this machine itself stays off the proxy
```

## In a container

The same proxy as a container: [Docker/README.md](../Docker/README.md). From another container
of the same Compose project, the address is the service's name, for example `http://hproxy:8080`.
