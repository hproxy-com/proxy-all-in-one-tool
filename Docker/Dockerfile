# The hproxy command-line tool in a container: ghcr.io/hproxy-com/hproxy
#
# Built by .github/workflows/docker-release.yml, never by hand. The workflow downloads the Linux
# files of one release (cli-v<version>), checks each against the release's SHA256SUMS and its build
# record, and lays them out beside this file by platform:
#
#   linux/amd64/hproxy    hproxy-cli-linux-x86_64
#   linux/arm64/hproxy    hproxy-cli-linux-arm64
#   linux/arm/v6/hproxy   hproxy-cli-linux-armv6
#   linux/arm/v7/hproxy   hproxy-cli-linux-armv6 (an ARMv6 program runs on every 32-bit ARM)
#
# One build makes the image for every processor, and Docker, Podman, Kubernetes and the clouds
# pick the right one by themselves.
#
# From scratch: the image holds the program and nothing else. The Linux files carry their own C
# library (musl) and their own list of trusted certificates, so there is no operating system
# inside to install, patch or fall out of date, and no shell.

FROM scratch

ARG TARGETPLATFORM
ARG VERSION

COPY ${TARGETPLATFORM}/hproxy /usr/local/bin/hproxy

# A home the program may write in: a background connection's entry (`hproxy status`), and what it
# keeps when someone mounts a volume here.
COPY --chown=65532:65532 home/ /home/hproxy/

# HOME decides every folder the program writes to (~/.local/state, ~/.cache, ~/.config).
# The daily update notice points at the files on GitHub, the wrong advice in a container, where
# the update is `docker pull`. The one-time usage question would come back in every throwaway
# container. Both are off here; `-e HPROXY_NO_USAGE=0` with a volume on /home/hproxy brings the
# question back, and `hproxy usage on` answers it.
ENV PATH=/usr/local/bin \
    HOME=/home/hproxy \
    HPROXY_NO_UPDATE_CHECK=1 \
    HPROXY_NO_USAGE=1

# Not root: the relay needs no privilege, and neither does port 8080.
USER 65532:65532
WORKDIR /home/hproxy

# Where `hproxy connect --listen 0.0.0.0:8080 --allow-lan` listens (HTTP and SOCKS5 on one port).
EXPOSE 8080

# The relay stops cleanly on Ctrl+C (SIGINT). In a container it is process 1, which ignores the
# signals it does not handle, so `docker stop` would otherwise send SIGTERM, wait 10 seconds and
# kill it.
STOPSIGNAL SIGINT

LABEL org.opencontainers.image.title="hproxy" \
      org.opencontainers.image.description="HProxy command-line tool. Rotate your own proxies or the free pool through one local HTTP and SOCKS5 port. Check proxies and list free ones. Look up IPs. Give AI assistants the same tools (MCP)." \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/hproxy-com/proxy-all-in-one-tool" \
      org.opencontainers.image.documentation="https://github.com/hproxy-com/proxy-all-in-one-tool/tree/main/Docker" \
      org.opencontainers.image.url="https://hproxy.com/tools/ai" \
      org.opencontainers.image.vendor="HProxy" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/usr/local/bin/hproxy"]
CMD ["--help"]
