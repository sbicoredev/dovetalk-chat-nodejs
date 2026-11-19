# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f apps/api/Dockerfile -t dovetalk-api .

ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm HUSKY=0 TURBO_TELEMETRY_DISABLED=1
ENV PATH=$PNPM_HOME:$PATH
# Keep in step with "packageManager" and the "turbo" devDependency in the root package.json.
RUN npm install --global pnpm@12.21.0 turbo@2.11.12
WORKDIR /repo

# Cuts the monorepo down to this app and the packages it uses. out/json holds only the package.json
# files and the lockfile, so the install layer below is rebuilt only when dependencies change.
FROM base AS prune
COPY . .
RUN turbo prune @dovetalk/api --docker

FROM base AS build
# Fetching first keeps this layer cached until the lockfile changes.
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@dovetalk/api..."
COPY --from=prune /repo/out/full/ ./
# turbo prune leaves out the root tsconfig that every package extends.
COPY tsconfig.base.json ./
# Builds the shared packages first, then the app.
RUN turbo run build --filter=@dovetalk/api
# A self-contained folder: compiled app, compiled workspace packages, production dependencies only.
RUN pnpm --filter @dovetalk/api deploy --prod /out

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
