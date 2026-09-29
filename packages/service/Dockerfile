FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/service/package.json packages/service/
RUN pnpm install --frozen-lockfile --filter @drip/service...
COPY packages/shared packages/shared
COPY packages/service packages/service
RUN pnpm --filter @drip/shared build && pnpm --filter @drip/service build
RUN pnpm --filter @drip/service --prod deploy /out

FROM node:22-slim AS clibuild
RUN corepack enable \
 && apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
WORKDIR /app
ARG DRIP_VERSION=dev
ARG DRIP_BAKED_BASE_URL=
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile --filter @drip/cli...
COPY packages/shared packages/shared
COPY packages/cli packages/cli
RUN pnpm --filter @drip/shared build
RUN DRIP_VERSION="$DRIP_VERSION" DRIP_BAKED_BASE_URL="$DRIP_BAKED_BASE_URL" \
    sh packages/cli/scripts/build-binaries.sh /out/dl

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DRIP_DATA_DIR=/data
COPY --from=build /out /app
COPY --from=clibuild /out/dl /app/public/dl
COPY packages/service/public/index.html packages/service/public/install.sh /app/public/
COPY packages/service/public/raycast /app/public/raycast
VOLUME /data
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
