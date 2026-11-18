#!/usr/bin/with-contenv bashio
# The settings from the add-on's Configuration tab, then the rotating proxy on port 8080.
set -e

source=$(bashio::config 'source')
rotate=$(bashio::config 'rotate')
country=$(bashio::config 'country')

# Inside the add-on the proxy has to listen on its own network to be reachable at all; Home
# Assistant then offers port 8080 on its address in your home network.
args=(connect --listen 0.0.0.0:8080 --allow-lan)

if [ "${source}" = "free" ]; then
    args+=(--free)
    if [ -n "${country}" ]; then
        args+=(--country "${country}")
    fi
    bashio::log.info "The free HProxy pool${country:+ in ${country}}, a new exit whenever one stops answering."
else
    list=/tmp/proxies.txt
    umask 077
    bashio::config 'proxies' > "${list}"
    count=$(grep -c . "${list}" || true)
    if [ "${count}" -eq 0 ]; then
        bashio::exit.nok "No proxies yet: add them in the Configuration tab, or choose source: free."
    fi
    args+=(--file "${list}" --rotate "${rotate}")
    bashio::log.info "${count} of your proxies, rotation: ${rotate}."
fi

export HPROXY_NO_UPDATE_CHECK=1
export HPROXY_NO_USAGE=1
bashio::log.info "Point your devices at this machine's address, port 8080 (HTTP or SOCKS5)."
exec hproxy "${args[@]}"
