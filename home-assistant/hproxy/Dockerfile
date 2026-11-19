# HProxy's rotating proxy as a Home Assistant add-on. The program comes from the published image
# ghcr.io/hproxy-com/hproxy (built only from the release's checked files); Home Assistant's own
# base image adds bashio, which reads the add-on's settings.
ARG BUILD_FROM
FROM ghcr.io/hproxy-com/hproxy:0.4.9 AS hproxy

FROM ${BUILD_FROM}
COPY --from=hproxy /usr/local/bin/hproxy /usr/bin/hproxy
COPY run.sh /run.sh
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]
