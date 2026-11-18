# Tools and apps through the rotating proxy

Start the proxy once (`hproxy connect --file proxies.txt --background`), then give each tool the
address `127.0.0.1:8080`, with no username and no password. It speaks HTTP and SOCKS5 on that port.

## Command-line tools

[tools.sh](tools.sh) runs the first six, and this repository's tests run it on every change.

| Tool | Through the proxy |
| --- | --- |
| curl | `curl -x http://127.0.0.1:8080 https://example.com` |
| wget | `wget -e use_proxy=yes -e https_proxy=http://127.0.0.1:8080 https://example.com` |
| aria2 | `aria2c --all-proxy=http://127.0.0.1:8080 https://example.com/file.zip` |
| HTTPie | `http --proxy=https:http://127.0.0.1:8080 https://example.com` |
| git | `git -c http.proxy=http://127.0.0.1:8080 clone https://github.com/...` |
| pip | `pip install --proxy http://127.0.0.1:8080 requests` |
| npm | `npm install --proxy http://127.0.0.1:8080 --https-proxy http://127.0.0.1:8080` |
| yt-dlp | `yt-dlp --proxy http://127.0.0.1:8080 <link>` |
| ffmpeg | `ffmpeg -http_proxy http://127.0.0.1:8080 -i <link> out.mp4` |
| ssh | `ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:8080 %h %p' user@host` (SOCKS5, OpenBSD netcat) |

Most other tools read the environment:

```sh
export HTTP_PROXY=http://127.0.0.1:8080 HTTPS_PROXY=http://127.0.0.1:8080 ALL_PROXY=socks5h://127.0.0.1:8080
export NO_PROXY=localhost,127.0.0.1
```

## Browsers

| Browser | Where |
| --- | --- |
| Chrome, Edge, Brave | They use the system's proxy (below), or start one with `--proxy-server=http://127.0.0.1:8080` |
| Firefox | Settings, Network Settings, Manual proxy configuration: HTTP Proxy `127.0.0.1`, Port `8080`, tick "Also use this proxy for HTTPS" |

Browsers cannot send a proxy password from the command line, and the system settings of Windows
have no field for one. hproxy needs none, so this works with proxies that have a login: hproxy
adds it on the way out.

## The whole computer

| System | Where |
| --- | --- |
| Windows 10 and 11 | Settings, Network & internet, Proxy, Manual proxy setup: `127.0.0.1`, port `8080` |
| macOS | System Settings, Network, your network, Details, Proxies: Web proxy (HTTP) and Secure web proxy (HTTPS), `127.0.0.1`, port `8080` |
| Linux (GNOME) | Settings, Network, Network Proxy, Manual: HTTP and HTTPS proxy `127.0.0.1`, port `8080` |

The HProxy app does the same with one switch, and with no proxy settings to undo afterwards.

## Other devices: phones, TVs, consoles

A proxy on `127.0.0.1` serves this computer alone. For the other devices of your home network, run
it on the network's side, `hproxy connect --file proxies.txt --listen 0.0.0.0:8080 --allow-lan`, and
give each device this computer's address and port `8080`: on a phone in the Wi-Fi settings of the
network (Proxy: Manual), elsewhere in the device's network settings. Never open port 8080 on your
router: the proxy has no password.

## Apps with their own proxy settings

Many apps have a proxy field of their own (Telegram, Spotify, qBittorrent, Postman, Visual Studio
Code, Docker Desktop and others): type `127.0.0.1` and `8080`, choose HTTP (or SOCKS5 where only
that is offered), and leave the username and password empty.
