# HProxy for macOS

For Macs with Apple Silicon or Intel, macOS 12 and later.

The macOS app is built on GitHub's own Mac machines. It arrives as `hproxy-macos-universal.dmg` on
the **[Releases page](https://github.com/hproxy-com/proxy-all-in-one-tool/releases)** with the
next version.

## Install

1. Open the `.dmg` and drag HProxy into Applications.
2. The app is not notarized with Apple yet, so the first time macOS says it cannot check it.
   Open **System Settings**, then **Privacy & Security**, and click **Open Anyway** once.

## Command line

The command-line tool is out now, for Apple Silicon (macOS 11 and later) and Intel (macOS 10.13 and
later): `hproxy`, the same engine without a window, in one file.

```sh
curl -fsSL https://hproxy.com/install.sh | sh
```

It picks the file for your Mac and lands in `~/.local/bin` after a check against its SHA-256,
without sudo. The files are on
[the release](https://github.com/hproxy-com/proxy-all-in-one-tool/releases/tag/cli-v0.2.8). The
commands are in [source-code/README.md](../source-code/README.md#command-line).
