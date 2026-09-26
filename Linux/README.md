# HProxy for Linux

For 64-bit Linux (x86_64). Both files arrive on the
**[Releases page](https://github.com/hproxy-com/proxy-all-in-one-tool/releases)** with the next
version:

| File | For |
| --- | --- |
| `hproxy-linux-x86_64.AppImage` | Any distribution. It needs `libwebkit2gtk-4.1`, which Ubuntu 22.04 and newer and Fedora 37 and newer have. Make it executable with `chmod +x` and run it. |
| `hproxy-linux-x86_64.deb` | Debian and Ubuntu: `sudo apt install ./hproxy-linux-x86_64.deb` installs it with everything it needs. |

## Servers and scripts

`hproxy-cli-linux-x86_64` is the same engine without a window: one static file that runs on every
Linux, for servers, containers and AI agents. The commands are in
[source-code/README.md](../source-code/README.md).
