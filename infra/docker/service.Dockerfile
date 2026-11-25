# syntax=docker/dockerfile:1
# One image per service: docker build --build-arg SERVICE=auth -f infra/docker/service.Dockerfile .

# Every workspace's package.json plus the lockfile, so `npm ci` sees the whole workspace (and the layer is
# shared by every service build until a dependency changes).
FROM node:22-alpine AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out && find . -name package.json -not -path '*/node_modules/*' | tar -cf - -T - | tar -xf - -C /out && cp package-lock.json /out/

FROM node:22-alpine AS build
WORKDIR /repo
COPY --from=manifests /out ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages packages
COPY services services
COPY scripts scripts
RUN node scripts/build-services.mjs

FROM node:22-alpine AS runtime
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE}
WORKDIR /app
RUN apk add --no-cache tini && addgroup -S talkie && adduser -S talkie -G talkie
COPY --from=manifests /out ./
RUN npm ci --omit=dev --workspace services/${SERVICE} --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /repo/services/${SERVICE}/dist services/${SERVICE}/dist
USER talkie
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "exec node --enable-source-maps services/${SERVICE}/dist/main.js"]
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
