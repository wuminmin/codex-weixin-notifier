FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY scripts ./scripts
COPY skills ./skills
RUN chmod +x scripts/catm.mjs scripts/catm-daemon.mjs \
    && ln -s /app/scripts/catm.mjs /usr/local/bin/catm \
    && mkdir -p /data \
    && chown -R node:node /data /app

ENV NODE_ENV=production \
    XDG_CONFIG_HOME=/data/config \
    XDG_DATA_HOME=/data/share \
    XDG_STATE_HOME=/data/state

VOLUME ["/data"]
USER node
EXPOSE 61937
ENTRYPOINT ["catm"]
CMD ["server"]
