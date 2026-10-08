# HProxy for Windows

**[Download HProxy for Windows](https://hproxy.com/downloads/desktop/hproxy-windows-x64-setup.exe)**
(the installer, about 4 MB, for Windows 10 and 11, 64-bit)

## Install

1. Open the downloaded `hproxy-windows-x64-setup.exe`.
2. The installer is not signed with a paid certificate yet, so Windows may say "Windows
   protected your PC". Click **More info**, then **Run anyway**.
3. Start HProxy from the Start menu.

## Updates

HProxy updates itself from hproxy.com. Every update is signed, and the app checks the signature
before it installs anything. While you use the app it waits for your click; while nobody uses it,
it updates quietly.

HProxy is also on the **[Microsoft Store](https://apps.microsoft.com/detail/9NPDSV0K3J1X)**. The Store
keeps that copy up to date, and a new version reaches it after the Store's own review.

## Command line

The command-line tool is out now, for Windows 10 and 11 on x64 and on ARM: `hproxy`, the same
engine without a window, in one file. In PowerShell:

```powershell
irm https://hproxy.com/install.ps1 | iex
```

It picks the file for your processor, checks it against its SHA-256 and puts it in
`%LOCALAPPDATA%\hproxy`, which it adds to your PATH, without administrator rights. Nothing has to be
installed beside it: the file carries its own runtime. The files are on
[the release](https://github.com/hproxy-com/proxy-all-in-one-tool/releases/tag/cli-v0.2.8). The
commands are in [source-code/README.md](../source-code/README.md#command-line).
