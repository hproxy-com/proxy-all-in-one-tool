## 0.4.9

- hproxy 0.4.9 inside. Home Assistant and your scripts switch the proxy over HTTP:
  `POST http://localhost:8080/hproxy/new-ip` for the next proxy, `/hproxy/status` for the one in
  use. The Documentation tab shows a New IP button and a sensor.
- Next IP on a fresh start moves to the second proxy, where it used to stay on the first.

## 0.4.8.1

- More settings: `skip` (sites that go straight out, past the proxy), `only` (the reverse),
  `via` (a proxy in front of yours), `socks5` (free pool: SOCKS5 exits only) and `log_requests`
  (one line per request in the Log tab). hproxy 0.4.8 inside, as before.

## 0.4.8

- The first version: a rotating proxy on port 8080 (HTTP and SOCKS5), over your own proxies with a
  rotation rule, or over the free HProxy pool by country. hproxy 0.4.8 inside.
