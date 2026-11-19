## 1.2

- The app lives in [proxy-all-in-one-tool](https://github.com/hproxy-com/proxy-all-in-one-tool),
  in `flipper-zero/`, beside the HProxy apps and the `hproxy` command-line tool; its link on the
  Flipper points there. It works as 1.1 did.

## 1.1

- Built around your own proxies. The free proxies are gone, and `free.txt` from 1.0 is no longer
  read.
- Proxies come in three ways: typed on a keyboard with every printable character (the Flipper's own
  has no `.`, `:`, `@` or `/`), downloaded from a link by the WiFi board, or picked from a `.txt`
  file on the SD card. Every shape a provider prints is read by the rules of hproxy.com's checker
  (`host:port:user:pass`, `user:pass@host:port`, `user:pass:host:port`, gateway names, IPv6, commas,
  bars, tabs, spaces); up to 100, each proxy once.
- A check tries HTTP, HTTPS, SOCKS4 and SOCKS5 and every result leads with the protocol that
  answered (`socks5 203.0.113.24:1080`). A dead one says why: nothing answers, no answer in time,
  turned away (a login it wants, or a wrong one), or no proxy at all.
- Send logins, off at first: lines with a username and password go to the checker only when it is
  on. No screen shows a password.
- Remove the dead ones after a check; the list as it was stays as `proxies.bak`.
- `alive.txt` puts `socks5://` in front of a SOCKS-only proxy whose line named no protocol, so other
  tools speak the right one.
- My connector: New IP, what it uses now, and a proxy by its number on the hproxy connector (0.4.9 or
  newer), with its login when it has one.

## 1.0

- Free proxies from hproxy.com by protocol, country and count, saved to apps_data/hproxy/free.txt,
  with "Check these now" right on the list.
- Check your own list (apps_data/hproxy/proxies.txt) or the last free list through hproxy.com's
  checker, ten proxies per request; the ones that answer are saved to apps_data/hproxy/alive.txt.
- Lines with a login stay on the Flipper.
- A progress screen with a bar and live counts (alive, dead, slow), a green blink for every
  proxy that works, and a short vibration when a job ends.
- Results as a list, the fastest first; OK on one shows its country, speed, anonymity and protocols.
- The free-list choices are kept between runs (apps_data/hproxy/settings.txt).
