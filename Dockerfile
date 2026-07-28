# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM dependencies AS test

COPY src ./src
COPY web ./web
COPY extension ./extension
COPY test ./test
RUN npm test

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    MONKEYCODE_PANEL_HOST=0.0.0.0 \
    MONKEYCODE_PANEL_PORT=4180 \
    MONKEYCODE_DATA_DIR=/data

WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web

RUN mkdir /data && chown node:node /data

LABEL org.opencontainers.image.source="https://github.com/mufenxu/mk"

USER node
EXPOSE 4180

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4180/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "src/panel.mjs"]
