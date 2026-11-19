# hproxy for Python

The `hproxy` command-line tool, for your Python environments: check proxies in any shape a provider
prints, run a rotating proxy on your machine over your own list, and switch it to a new IP from any
script. The package carries the tool itself, one program for your system, and installs it as the
command `hproxy` beside your environment's other scripts. It needs no other Python package.

## Use it

```sh
hproxy check --file proxies.txt --alive          # which of your proxies work, from here
hproxy connect --file proxies.txt --rotate every --background
curl -x http://127.0.0.1:8080 https://example.com
hproxy new-ip                                   # the next proxy, now
hproxy status                                   # what runs, and through which proxy
```

`hproxy connect` gives every program on your machine one proxy at `127.0.0.1:8080`, HTTP and SOCKS5
on the same port, with no login: the next of your proxies for every connection, or by the rule you
pick (`every:25`, `every:10m`, `random`, `on-failure`). Your proxies can be `host:port:user:pass`,
`user:pass@host:port`, `socks5://...`, or any other shape a provider prints.

## From Python

```python
import subprocess

import requests
from hproxy_cli import find_hproxy_bin

hproxy = find_hproxy_bin()
subprocess.run([hproxy, "connect", "--file", "proxies.txt", "--background"], check=True)

proxies = {"http": "http://127.0.0.1:8080", "https": "http://127.0.0.1:8080"}
print(requests.get("https://hproxy.com/cdn-cgi/trace", proxies=proxies, timeout=30).text)

requests.post("http://127.0.0.1:8080/hproxy/new-ip", timeout=10)  # the next proxy, from your script
```

`python -m hproxy_cli` runs the same program. The same for requests, httpx, aiohttp, Scrapy,
Playwright and the other tools and languages: [the tested examples](https://github.com/hproxy-com/proxy-all-in-one-tool/tree/main/examples).

## Systems

| System | Processors |
| --- | --- |
| Linux, any distribution, Alpine included | x86_64, ARM64, 32-bit ARM (ARMv7), 32-bit x86 |
| macOS | Apple Silicon (macOS 11 and later), Intel (macOS 10.13 and later) |
| Windows | x64, ARM64, 32-bit |

Every wheel holds the very file of the GitHub release with the same version, checked against its
SHA-256 when the wheel is made: the release's files are built in public by
[the repository's workflow](https://github.com/hproxy-com/proxy-all-in-one-tool/actions/workflows/cli-release.yml),
each with a signed record of how it was built.

## More

[Every command](https://github.com/hproxy-com/proxy-all-in-one-tool/blob/main/source-code/README.md#command-line)
· [The apps for Windows, macOS, Linux and Android](https://github.com/hproxy-com/proxy-all-in-one-tool)
· [hproxy.com](https://hproxy.com)

MIT license.
