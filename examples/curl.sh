#!/bin/sh
# Three requests through the rotating proxy. Each curl opens its own connection, and every new
# connection goes out through the next proxy of your list.
#
# Start the proxy first:  hproxy connect --file proxies.txt --background
# Then:                   sh curl.sh

PROXY=http://127.0.0.1:8080 # where hproxy connect listens

for i in 1 2 3; do
    # Over SOCKS5 instead: curl --socks5-hostname 127.0.0.1:8080 ...
    seen=$(curl -fsS -x "$PROXY" https://hproxy.com/cdn-cgi/trace | grep -E '^(ip|loc)=' | tr '\n' ' ')
    echo "$i: $seen"
done
