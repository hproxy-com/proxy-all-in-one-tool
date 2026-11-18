#!/usr/bin/with-contenv bash
# The settings from the add-on's Configuration tab, then the rotating proxy on port 8080.
# Home Assistant writes the settings to /data/options.json; they are read straight from there.
set -euo pipefail

options=/data/options.json
source=$(jq -r '.source // "free"' "${options}")
rotate=$(jq -r '.rotate // "every"' "${options}")
country=$(jq -r '.country // ""' "${options}")

# Inside the add-on the proxy has to listen on its own network to be reachable at all; Home
# Assistant then offers port 8080 on its address in your home network.
args=(connect --listen 0.0.0.0:8080 --allow-lan)

if [ "${source}" = "free" ]; then
    args+=(--free)
    if [ -n "${country}" ]; then
        args+=(--country "${country}")
    fi
    echo "[HProxy] The free HProxy pool${country:+ in ${country}}, a new exit whenever one stops answering."
else
    list=/tmp/proxies.txt
    umask 077
    jq -r '.proxies[]? // empty' "${options}" > "${list}"
    count=$(grep -c . "${list}" || true)
    if [ "${count}" -eq 0 ]; then
        echo "[HProxy] No proxies yet: add them in the Configuration tab, or choose source: free." >&2
        exit 1
    fi
    args+=(--file "${list}" --rotate "${rotate}")
    echo "[HProxy] ${count} of your proxies, rotation: ${rotate}."
fi

export HPROXY_NO_UPDATE_CHECK=1
export HPROXY_NO_USAGE=1
echo "[HProxy] Point your devices at this machine's address, port 8080 (HTTP or SOCKS5)."
exec hproxy "${args[@]}"
