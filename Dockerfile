# The server, and the pages it serves, as one image.
#
# One origin for both: the browser app's calls carry no origin of their own and its session cookie
# is `SameSite=Lax`, so a page served from anywhere else arrives signed out. A deployment that
# would rather put a proxy or a CDN in front of the pages leaves `WEB_ROOT` unset — see
# `apps/server/src/server/browser-app.ts`.

FROM node:24-slim

# dbmate's binary is fetched by its install script and reaches the database over TLS.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The version in package.json, not whichever pnpm this base image happens to carry.
RUN corepack enable

WORKDIR /app

# Everything, including what only the build needs. Not pruned afterwards on purpose: `pnpm
# release` applies the migrations from inside this image, and the tool that applies them is a
# development dependency — pruning it would mean carrying it twice or fetching it during a deploy.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY packages/universal/package.json packages/universal/
RUN pnpm install --frozen-lockfile

COPY . .

# The pages, built once here rather than on every start.
RUN pnpm build

# Where those pages ended up. Said here so the image is complete: a deployment that wants a proxy
# in front of them instead overrides it to nothing.
ENV WEB_ROOT=/app/apps/web/dist
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Not root. Nothing in here writes to its own directory, so it does not need to own one.
USER node

# Migrations are a release step, not a startup step: two instances starting at once would both
# run them, and a deploy that half-succeeded would leave the schema half-applied with nobody to
# say so. Run `pnpm --filter @handover/server release` once, before the new instances start.
CMD ["pnpm", "--filter", "@handover/server", "start"]
