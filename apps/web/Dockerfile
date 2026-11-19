# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f apps/web/Dockerfile -t dovetalk-web .
#
# NEXT_PUBLIC_* values are put into the browser code when the app is built, and API_PROXY_TARGET
# into its /api rewrite, so they are build arguments: change them and build again.

ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm HUSKY=0 NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1
ENV PATH=$PNPM_HOME:$PATH
# Keep in step with "packageManager" and the "turbo" devDependency in the root package.json.
RUN npm install --global pnpm@12.21.0 turbo@2.11.12
WORKDIR /repo

# Cuts the monorepo down to this app and the packages it uses. out/json holds only the package.json
# files and the lockfile, so the install layer below is rebuilt only when dependencies change.
FROM base AS prune
COPY . .
RUN turbo prune @dovetalk/web --docker

FROM base AS build
# The browser calls the API through this app's /api path (so the sign-in cookie is first-party)
# and opens the socket straight on the API, which must be reachable from the browser.
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_WS_URL=http://localhost:3001
# Where this server reaches the API: the Compose service name, not a browser address.
ARG API_PROXY_TARGET=http://api:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    API_PROXY_TARGET=$API_PROXY_TARGET \
    NEXT_STANDALONE=1
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@dovetalk/web..."
COPY --from=prune /repo/out/full/ ./
# turbo prune leaves out the root tsconfig that every package extends.
COPY tsconfig.base.json ./
# Builds the contracts package, then the app into .next/standalone.
RUN turbo run build --filter=@dovetalk/web

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# The traced server keeps the repository's layout: apps/web/server.js. Static files sit beside it.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
