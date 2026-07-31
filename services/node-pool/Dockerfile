# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS source

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY README.md worker.config.example.json ./

FROM source AS test
COPY test ./test
RUN npm run check

FROM source AS bundle
RUN tar -czf /monkeycode-node-pool.tar.gz .

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    MK_CONTROLLER_HOST=0.0.0.0 \
    MK_CONTROLLER_PORT=4191 \
    MK_STATE_FILE=/data/state.json \
    MK_WORKER_BUNDLE_FILE=/dist/monkeycode-node-pool.tar.gz

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --from=bundle --chown=node:node /monkeycode-node-pool.tar.gz /dist/monkeycode-node-pool.tar.gz

RUN mkdir -p /data && chown node:node /data

LABEL org.opencontainers.image.source="https://github.com/mufenxu/mk"

USER node
EXPOSE 4191

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4191/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "src/controller.mjs"]
