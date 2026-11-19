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
runs on every Linux, on x86_64 and on ARM (64-bit, and 32-bit for every Raspberry Pi), on 32-bit PCs
and on RISC-V, for servers, containers and AI agents.

```sh
curl -fsSL https://hproxy.com/install.sh | sh
```

It picks the file for the processor and lands in `~/.local/bin` (or `$HPROXY_INSTALL_DIR`) after a
check against its SHA-256, without sudo. Or with [Homebrew](https://brew.sh):
`brew install hproxy-com/tap/hproxy`. The files themselves (`hproxy-cli-linux-x86_64`,
`hproxy-cli-linux-arm64`, `hproxy-cli-linux-armv6`, `hproxy-cli-linux-i686`,
`hproxy-cli-linux-riscv64`) are attached to every
[command-line release](https://github.com/hproxy-com/proxy-all-in-one-tool/releases) (`cli-v` and
its version). The commands are in [source-code/README.md](../source-code/README.md#command-line),
and the same proxy from your own code, in every language, in [examples](../examples/).

On a router or a small system without curl (OpenWrt, Alpine, BusyBox), the installer uses wget, and
it checks the file with whichever SHA-256 tool the system has:

```sh
wget -qO- https://hproxy.com/install.sh | sh
```

Routers with an ARM or x86 processor run it, which covers most new ones; the older MIPS routers have
no file of their own. Where the flash is small, `HPROXY_INSTALL_DIR=/tmp` puts it in memory until the
next restart. On FreeBSD (14.4 and newer, x86_64), its own `fetch` does the same:

```sh
fetch -qo - https://hproxy.com/install.sh | sh
```

In a container, for Docker, Podman, Kubernetes and the clouds' container services (Amazon ECS,
Fargate and EKS on Intel and Graviton), on x86_64 and ARM:
[ghcr.io/hproxy-com/hproxy](../Docker/), with the rotating proxy beside your app.
