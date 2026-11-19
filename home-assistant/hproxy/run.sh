#!/usr/bin/with-contenv bash
# The settings from the add-on's Configuration tab, then the rotating proxy on port 8080.
# Home Assistant writes the settings to /data/options.json; they are read straight from there.
set -euo pipefail

options=/data/options.json
source=$(jq -r '.source // "own"' "${options}")
rotate=$(jq -r '.rotate // "every"' "${options}")
country=$(jq -r '.country // ""' "${options}")
socks5=$(jq -r '.socks5 // false' "${options}")
skip=$(jq -r '[.skip[]? // empty] | join(",")' "${options}")
only=$(jq -r '[.only[]? // empty] | join(",")' "${options}")
via=$(jq -r '.via // ""' "${options}")
log_requests=$(jq -r '.log_requests // false' "${options}")

# Inside the add-on the proxy has to listen on its own network to be reachable at all; Home
# Assistant then offers port 8080 on its address in your home network.
args=(connect --listen 0.0.0.0:8080 --allow-lan)

if [ "${source}" = "free" ]; then
    args+=(--free)
    if [ -n "${country}" ]; then
        args+=(--country "${country}")
    fi
    exits=""
    if [ "${socks5}" = "true" ]; then
        args+=(--socks5)
        exits=", SOCKS5 exits"
    fi
    echo "[HProxy] The free HProxy pool${country:+ in ${country}}${exits}, a new exit whenever one stops answering."
else
    list=/tmp/proxies.txt
    umask 077
    jq -r '.proxies[]? // empty' "${options}" > "${list}"
    count=$(grep -c . "${list}" || true)
    if [ "${count}" -eq 0 ]; then
        echo "[HProxy] No proxies yet: add yours under Your proxies in the Configuration tab, one per entry, in any shape your provider prints." >&2
        exit 1
    fi
    args+=(--file "${list}" --rotate "${rotate}")
    echo "[HProxy] ${count} of your proxies, rotation: ${rotate}."
fi

if [ -n "${skip}" ] && [ -n "${only}" ]; then
    echo "[HProxy] skip and only say opposite things: fill in one of them and leave the other empty." >&2
    exit 1
fi
if [ -n "${skip}" ]; then
    args+=(--skip "${skip}")
    echo "[HProxy] Straight out, past the proxy: ${skip}"
fi
if [ -n "${only}" ]; then
    args+=(--only "${only}")
    echo "[HProxy] Only these sites use the proxy: ${only}"
fi
if [ -n "${via}" ]; then
    args+=(--via "${via}")
    echo "[HProxy] Through your first proxy (via) on the way."
fi
if [ "${log_requests}" = "true" ]; then
    args+=(--verbose)
fi

export HPROXY_NO_UPDATE_CHECK=1
export HPROXY_NO_USAGE=1
echo "[HProxy] Point your devices at this machine's address, port 8080 (HTTP or SOCKS5)."
exec hproxy "${args[@]}"
