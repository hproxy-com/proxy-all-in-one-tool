# HProxy for Linux

For 64-bit Linux (x86_64):

| File | For |
| --- | --- |
| **[hproxy-linux-x86_64.AppImage](https://hproxy.com/downloads/desktop/hproxy-linux-x86_64.AppImage)** | Any distribution. It needs `libwebkit2gtk-4.1`, which Ubuntu 22.04 and newer and Fedora 37 and newer have. Make it executable with `chmod +x` and run it; it updates itself. |
| **[hproxy-linux-x86_64.deb](https://hproxy.com/downloads/desktop/hproxy-linux-x86_64.deb)** | Debian and Ubuntu: `sudo apt install ./hproxy-linux-x86_64.deb` installs it with everything it needs. |

Both are built on GitHub's own machines from [source-code](../source-code/), and the same files are on
the **[Releases page](https://github.com/hproxy-com/proxy-all-in-one-tool/releases)** with their SHA-256
and build records.

## Servers and scripts

The command-line tool is out now: `hproxy`, the same engine without a window, one static file that
runs on every Linux, on x86_64 and on ARM (64-bit, and 32-bit for every Raspberry Pi), for servers,
containers and AI agents.

```sh
curl -fsSL https://hproxy.com/install.sh | sh
```

It picks the file for the processor and lands in `~/.local/bin` (or `$HPROXY_INSTALL_DIR`) after a
check against its SHA-256, without sudo. The files themselves (`hproxy-cli-linux-x86_64`,
`hproxy-cli-linux-arm64`, `hproxy-cli-linux-armv6`) are on
[the release](https://github.com/hproxy-com/proxy-all-in-one-tool/releases/tag/cli-v0.2.8). The
commands are in [source-code/README.md](../source-code/README.md#command-line).
