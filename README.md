<p align="center">
  <a href="https://hproxy.com"><img src="assets/banner.svg" alt="HProxy: Proxy Checker, Connector &amp; Switcher" width="720"></a>
</p>

<p align="center">
  <a href="https://hproxy.com/downloads/desktop/hproxy-windows-x64-setup.exe"><img src="https://img.shields.io/badge/Download_for-Windows-0158FF?style=for-the-badge&amp;labelColor=0B1220&amp;logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iI2ZmZmZmZiIgZD0iTTAgMGgxMS4zdjExLjNIMHpNMTIuNyAwSDI0djExLjNIMTIuN3pNMCAxMi43aDExLjNWMjRIMHpNMTIuNyAxMi43SDI0VjI0SDEyLjd6Ii8%2BPC9zdmc%2B" alt="Download for Windows"></a>
  <a href="macOS/"><img src="https://img.shields.io/badge/Download_for-macOS-0158FF?style=for-the-badge&logo=apple&logoColor=white&labelColor=0B1220" alt="Download for macOS"></a>
  <a href="Linux/"><img src="https://img.shields.io/badge/Download_for-Linux-0158FF?style=for-the-badge&logo=linux&logoColor=white&labelColor=0B1220" alt="Download for Linux"></a>
  <a href="Android/"><img src="https://img.shields.io/badge/Download_for-Android-0158FF?style=for-the-badge&logo=android&logoColor=white&labelColor=0B1220" alt="Download for Android"></a>
</p>

<p align="center">
  <a href="https://hproxy.com"><img src="https://img.shields.io/badge/Website-hproxy.com-0158FF?style=flat-square&labelColor=0B1220" alt="Website: hproxy.com"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-0158FF?style=flat-square&labelColor=0B1220" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Price-free-0158FF?style=flat-square&labelColor=0B1220" alt="Price: free">
  <img src="https://img.shields.io/badge/Account-none_needed-0158FF?style=flat-square&labelColor=0B1220" alt="No account needed">
  <a href="source-code/README.md#for-ai-assistants-mcp"><img src="https://img.shields.io/badge/AI_assistants-MCP_server-0158FF?style=flat-square&labelColor=0B1220" alt="MCP server for AI assistants"></a>
</p>

<h3 align="center">The proxy all-in-one tool</h3>

<p align="center"><b>Check</b> any proxy list, see where every proxy comes out and how anonymous it is,<br>then <b>switch</b> your computer, phone or browser to the one you pick.</p>

## Download

| System | | |
| --- | --- | --- |
| **Windows** 10 and 11 | **[Download the installer](https://hproxy.com/downloads/desktop/hproxy-windows-x64-setup.exe)** | [how to install](Windows/) |
| **macOS** 12 and later, Apple Silicon and Intel | with the next version | [macOS](macOS/) |
| **Linux** x86_64: AppImage and .deb | with the next version | [Linux](Linux/) |
| **Android** 7 and later | Google Play and the APK | [Android](Android/) |
| **Command line and AI assistants** | `hproxy` and its MCP server | [source-code](source-code/README.md#command-line) |

## What it does

- **Checks any proxy list** in the format your provider prints it: HTTP, HTTPS, SOCKS4 and
  SOCKS5, detected per line, with every result showing the moment it arrives.
- **Shows the evidence**: where each proxy comes out (country, city, network), how anonymous it
  is, how long each step takes, which headers it added, and whether it reads your HTTPS. Never
  log in through one that does.
- **Fraud scores** for every working exit.
- **Switches** your computer to the proxy you pick, a list that rotates, or a free exit in the
  country you want, without typing a password anywhere.
- **Works from the command line and from AI assistants**: `hproxy check`, `hproxy connect`, and
  an MCP server with `proxy_list`, `proxy_check` and `ip_lookup`.
- **A Chrome extension** that does the same inside the browser.
- **Private by design**: checks run on your own device by default, and your list and its logins
  stay there. What goes out, and where to, is in [PRIVACY.md](source-code/PRIVACY.md).

## Build it yourself

Everything HProxy is made of is in [source-code](source-code/): the app (Tauri: Rust and React),
the command-line tool, the engine and the Chrome extension.
[source-code/README.md](source-code/README.md) says how to build and test each part.

<p align="center"><sub>Built by <a href="https://hproxy.com">HProxy</a> · <a href="LICENSE">MIT license</a></sub></p>
