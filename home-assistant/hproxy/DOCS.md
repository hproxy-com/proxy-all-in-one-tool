# HProxy rotating proxy

A proxy for your home network that sends every connection through your own proxies, one after
another, or through the free HProxy pool. Phones, computers and apps use it with no username or
password.

## Set it up

1. In the **Configuration** tab, choose the `source`:
   - `free`: the free HProxy pool, with a new exit whenever one stops answering. `country` picks
     one (US, DE, ...); leave it empty for any.
   - `own`: your proxies under `proxies`, one per entry, in any shape your provider prints
     (`host:port:user:pass`, `http://user:pass@host:port`, `socks5://...`). `rotate` sets how they
     take turns.
2. **Start** the add-on and look at the **Log** tab: it says what it uses.
3. Point a device or an app at your Home Assistant's address, port **8080**, as an HTTP proxy, or
   as SOCKS5 where only that is offered.

## Rotation

| `rotate` | What it does |
| --- | --- |
| `every` | A new proxy for every connection |
| `every:25` | A new one every 25 connections |
| `every:10m` | A new one every 10 minutes |
| `random` | One at random for each connection |
| `on-failure` | Stays with one until it stops answering |

## More settings

| Setting | What it does |
| --- | --- |
| `socks5` | With the free pool: only exits that speak SOCKS5 |
| `skip` | Sites that go straight out on your own address, past the proxy: your bank, a work tool, your own network (`192.168.0.0/16`) |
| `only` | The reverse: only these sites use the proxy, everything else goes straight out |
| `via` | A proxy in front of yours. Your proxies only ever see its address, which helps with a proxy that accepts one allowed address |
| `log_requests` | One line per request in the **Log** tab: which site and port, never a login |

A site is a name (`example.com` covers everything under it, like `www.example.com`), an address,
or a range (`10.0.0.0/8`). Fill in `skip` or `only`; the add-on stops with a note when both are
filled in.

## Who can reach it

Port 8080 on Home Assistant's address is open to your home network, and the proxy asks for no
password, so everyone on that network can use it. Keep it inside: never forward port 8080 on your
router. The port can be changed in the **Network** section of the Configuration tab.

## Your logins

Your proxies stay in Home Assistant's settings. The add-on writes them to a file only it can read,
and never into the log.

## Help

[hproxy.com](https://hproxy.com), or an issue at
[github.com/hproxy-com/home-assistant-addons](https://github.com/hproxy-com/home-assistant-addons/issues).
