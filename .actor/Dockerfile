# Dependency archives are integrity checked and only extracted into a fresh directory.
FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3 AS packages
WORKDIR /opt/off
COPY package.json package-lock.json ./
COPY scripts/bootstrap-locked.py ./scripts/bootstrap-locked.py
RUN python3 -B scripts/bootstrap-locked.py

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS validated
WORKDIR /app
COPY --from=packages /opt/off/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY apify/*.ts apify/tsconfig.json ./apify/
COPY tests ./tests
RUN node node_modules/typescript/bin/tsc --project apify/tsconfig.json --noEmit
RUN node --experimental-strip-types --test tests/*.test.ts

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
WORKDIR /app
COPY --from=packages --chown=node:node /opt/off/node_modules ./node_modules
COPY --from=validated --chown=node:node /app/package.json ./
COPY --from=validated --chown=node:node /app/src ./src
COPY --from=validated --chown=node:node /app/apify ./apify
ENV NODE_ENV=production
USER node
EXPOSE 4321
CMD ["node", "--experimental-strip-types", "apify/main.ts"]
