FROM node:20.19.1-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm prune --prod

FROM node:20.19.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install --no-install-recommends --yes sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system mintbot && useradd --system --gid mintbot mintbot
COPY --from=build --chown=mintbot:mintbot /app/package.json /app/pnpm-workspace.yaml /app/
COPY --from=build --chown=mintbot:mintbot /app/node_modules /app/node_modules
COPY --from=build --chown=mintbot:mintbot /app/packages /app/packages
COPY --from=build --chown=mintbot:mintbot /app/scripts /app/scripts
USER mintbot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "scripts/healthcheck.mjs"]
ENTRYPOINT ["node", "packages/cli/dist/index.js"]
