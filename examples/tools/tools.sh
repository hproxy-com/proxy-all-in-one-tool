#!/bin/sh
# Everyday command-line tools through the rotating proxy, each with its own proxy option. Every run
# of a tool opens its own connection, so each one goes out through the next proxy.
#
# Start the proxy first:  hproxy connect --file proxies.txt --background
# Then:                   sh tools.sh   (it runs the ones this machine has)
set -e

PROXY=http://127.0.0.1:8080 # where hproxy connect listens
TRACE=https://hproxy.com/cdn-cgi/trace
work=$(mktemp -d)

has() { command -v "$1" > /dev/null 2>&1; }
show() { grep -E '^(ip|loc)=' | tr '\n' ' '; echo; }

if has wget; then
    printf 'wget:   '
    wget -q -O - -e use_proxy=yes -e https_proxy="$PROXY" "$TRACE" | show
fi
if has aria2c; then
    printf 'aria2:  '
    aria2c -q --all-proxy="$PROXY" -d "$work" -o trace.txt "$TRACE"
    show < "$work/trace.txt"
fi
if has http; then
    printf 'HTTPie: '
    # --ignore-stdin: in a script, HTTPie would read the input as the request body.
    http --ignore-stdin --body --proxy="https:$PROXY" "$TRACE" | show
fi
if has git; then
    printf 'git:    '
    git -c http.proxy="$PROXY" ls-remote https://github.com/hproxy-com/proxy-all-in-one-tool HEAD | cut -c1-12
fi
if has pip; then
    printf 'pip:    '
    pip download -q --proxy "$PROXY" --no-deps -d "$work/pip" idna
    ls "$work/pip"
fi
if has npm; then
    printf 'npm:    '
    npm view --proxy "$PROXY" --https-proxy "$PROXY" undici version
fi

rm -rf "$work"
