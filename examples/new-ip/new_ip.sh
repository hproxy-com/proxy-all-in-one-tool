#!/bin/sh
# A new IP when your script decides, over plain HTTP on the rotating proxy's own port (hproxy 0.4.9
# and newer). Start it so it stays on one proxy until asked:
#
#   hproxy connect --file proxies.txt --rotate on-failure --background
#   sh new_ip.sh
#
# Every answer is one line of JSON with "ok" ("error" when ok is false). The open connections end
# with the switch, so the next request goes out the new way, also over a kept-alive connection.

CONTROL=http://127.0.0.1:8080/hproxy # the proxy's own address, then /hproxy

curl -fsS "$CONTROL/status"           # which proxy now, member N of M, the counts
curl -fsS -X POST "$CONTROL/new-ip"   # the next proxy

# A given proxy of your list, by its number:  curl -fsS -X POST "$CONTROL/new-ip?member=3"

# The same from a terminal, without curl: hproxy new-ip (--member N, --probe, --json)
