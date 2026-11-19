# HProxy add-ons for Home Assistant

[![Add this repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fhproxy-com%2Fhome-assistant-addons)

Or by hand: **Settings → Add-ons → Add-on store → ⋮ → Repositories**, and add
`https://github.com/hproxy-com/home-assistant-addons`.

## HProxy rotating proxy

Your own proxies, any kind your provider sells, as one proxy for your home network on port 8080 (HTTP
and SOCKS5): every connection goes through them, one after another. For 64-bit and 32-bit ARM
(Raspberry Pi, Home Assistant Green and Yellow) and for x86_64. Sites can skip it, a proxy can sit in
front of yours, and Home Assistant itself can switch it to the next proxy with a "New IP" button, as
can [a Flipper Zero](https://github.com/hproxy-com/flipper-zero-app). How to set it up:
[hproxy/DOCS.md](hproxy/DOCS.md).

The program inside is the `hproxy` command-line tool from
[ghcr.io/hproxy-com/hproxy](https://github.com/hproxy-com/proxy-all-in-one-tool/tree/main/Docker),
built only from the files of a release, each checked against its SHA-256 and its build record.

## License

MIT. [hproxy.com](https://hproxy.com)
