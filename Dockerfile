# ConfPilot as a container, for hosts that are not Cloudflare.
ARG SOURCE_URL
#
# The build stage has the whole monorepo because the SPA and the server are built
# together and the server bundle inlines the shared contracts package. The runtime
# stage keeps neither: it carries the bundle, the built SPA, the migrations, and
# the one dependency that cannot be bundled.
#
# `better-sqlite3` is native, so it stays external to the esbuild bundle and is
# carried across as a built tree. Everything else is inlined, which is why the
# runtime stage installs nothing and needs no lockfile or workspace layout.

FROM node:22-bookworm-slim AS build
ARG SOURCE_URL
WORKDIR /src
# `better-sqlite3` has no prebuilt binary for every platform this may be built
# on, so the toolchain has to be here. Only in this stage: what the runtime image
# receives is the compiled result, never a compiler.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable

# Manifests first, so a change to application source does not re-resolve the
# dependency graph on every rebuild.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile

COPY . .

# AGPL section 13: a network service must offer the source of the version it is
# actually running, so the web build refuses to produce an anonymous bundle. The
# one required build argument drives both public surfaces. There is deliberately
# no upstream default: a modified image must never advertise someone else's
# source by omission.
ENV VITE_SOURCE_URL=${SOURCE_URL}

RUN pnpm --filter @confpilot/web build \
 && pnpm --filter @confpilot/api build:node

# The native dependency, taken as the tree that was just built rather than
# reinstalled later.
#
# Reinstalling in the runtime stage looked tidier and was not reproducible: a
# manifest naming `better-sqlite3` alone leaves npm to resolve its transitive
# graph fresh, so a rebuild months from now can ship a different `node-addon-api`
# or `bindings` than this image was tested with — and pnpm's lockfile, which does
# pin them, is not a format npm can consume. Copying dereferences pnpm's symlinks
# into a plain tree, which is what the runtime stage needs anyway.
#
# Both stages are the same base image, so the compiled binding matches the Node
# and libc it will run against; a mismatch would fail loudly at require time
# rather than subtly.
RUN mkdir -p /runtime/node_modules \
 && cp -RL apps/api/node_modules/better-sqlite3 /runtime/node_modules/better-sqlite3 \
 && node -e "require('/runtime/node_modules/better-sqlite3')" \
 && printf '%s' '{"name":"confpilot","private":true,"type":"module"}' > /runtime/package.json


FROM node:22-bookworm-slim AS runtime
ARG SOURCE_URL
WORKDIR /srv/confpilot
ENV NODE_ENV=production \
    SOURCE_URL=${SOURCE_URL} \
    BUILD_SOURCE_URL=${SOURCE_URL}

# Bound to every interface because the loopback here is the container's own; the
# port is published only where the operator says so, and TLS belongs to whatever
# sits in front. `config.ts` explains why the application default is the opposite.
ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/var/lib/confpilot/confpilot.sqlite \
    FILES_DIRECTORY=/var/lib/confpilot/files \
    STATIC_DIRECTORY=/srv/confpilot/web \
    MIGRATIONS_DIRECTORY=/srv/confpilot/migrations

# Nothing is installed or compiled in this stage — the one dependency that
# survives bundling arrives already built, exactly as it was tested. (The base
# image still carries npm; this simply never runs it.)
COPY --from=build /runtime/package.json ./package.json
COPY --from=build /runtime/node_modules ./node_modules

COPY --from=build /src/apps/api/dist-node/server.mjs ./server.mjs
COPY --from=build /src/apps/api/scripts/apply-sqlite-artifact.mjs ./apply-sqlite-artifact.mjs
COPY --from=build /src/apps/api/scripts/migration-files.mjs ./migration-files.mjs
COPY --from=build /src/apps/api/scripts/sql-transaction-control.mjs ./sql-transaction-control.mjs
COPY --from=build /src/apps/api/migrations ./migrations
COPY --from=build /src/apps/web/dist ./web

# Private uploads and the database live on a volume; the image itself is
# read-only state. FILES_DIRECTORY sits outside STATIC_DIRECTORY on purpose —
# private objects are unreachable by URL only because of where they are put.
RUN mkdir -p /var/lib/confpilot/files && chown -R node:node /var/lib/confpilot
VOLUME ["/var/lib/confpilot"]

USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
