# syntax=docker/dockerfile:1
# One-shot database migrator: docker compose run --rm migrate
FROM node:22-alpine AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out && find . -name package.json -not -path '*/node_modules/*' | tar -cf - -T - | tar -xf - -C /out && cp package-lock.json /out/

FROM node:22-alpine
WORKDIR /repo
COPY --from=manifests /out ./
RUN npm ci --workspace packages/db --workspace packages/core --include-workspace-root --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY packages packages
COPY database database
COPY scripts/migrate.ts scripts/migrate.ts
COPY tsconfig.base.json tsconfig.json ./
ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "scripts/migrate.ts"]
