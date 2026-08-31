#!/bin/sh
# One release: bring the source up to date, build it, apply the migrations, then start.
#
# The order is the whole point. `docs/repository.md` 4.1: migrations are a step of the release and
# not a step of startup — two instances starting at once would both run them, and a deploy that
# half-applied would stop with nobody able to say where. So this applies them from a container
# that does nothing else, and only then replaces the running one.

set -eu

cd "$(dirname "$0")"

say() { printf '\n== %s\n' "$*"; }

say "source"
git -C .. fetch --quiet origin
git -C .. reset --hard --quiet "origin/${BRANCH:-main}"
git -C .. --no-pager log -1 --oneline

say "build"
docker compose build app

say "migrations"
# Its own container, run to completion, before anything new serves a request. `release` applies
# the migrations and does nothing else.
#
# Not `--no-deps`: what this needs is the database, and compose starting it is also compose
# waiting for its healthcheck. Without that the migration container came up first, could not
# resolve `db`, and spent a minute failing to connect to a name that did not exist yet.
docker compose up -d db objects
docker compose run --rm -T app pnpm --filter @handover/server release

say "the bucket"
# The other thing a release does once and must not half-do. `set -e` above is what makes this a
# step rather than a hope: a bucket that could not be made stops the release here, instead of
# surfacing days later as an upload that fails.
docker compose run --rm -T objects-ready

say "start"
docker compose up -d --remove-orphans

say "waiting for it to answer"
for _ in $(seq 1 60); do
  if docker compose exec -T app node -e 'fetch("http://127.0.0.1:3000/auth/credentials").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then
    say "up: $(git -C .. rev-parse --short HEAD)"
    exit 0
  fi
  sleep 2
done

say "it did not answer in two minutes"
docker compose logs --tail 40 app
exit 1
