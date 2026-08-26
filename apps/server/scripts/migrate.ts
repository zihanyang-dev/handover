/**
 * Brings a database up and applies every committed migration.
 *
 * Which database is whichever `DATABASE_URL` names, so `pnpm migrate` and `pnpm test:db` are this
 * same script pointed at different env files. It does not need creating by hand either: `dbmate
 * up` makes it when it is missing.
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from '../src/env.ts'
import { binary, capture, ROOT, run } from './run-command.ts'

const SERVICE = 'db'
const MIGRATIONS = 'migrations'
const SCHEMA = join(ROOT, 'generated', 'schema.sql')

/** Any fixed value works. This dump is a review artifact; it is never restored. */
const RESTRICT_KEY = 'handover'

/**
 * Dumped from inside the container, not from the host. The tools there always match the server,
 * and a fresh clone needs nothing installed beyond Docker. Which database gets dumped comes from
 * the same URL everything else uses, so there is no second place that names it.
 *
 * The dump has to be byte-identical run to run, because `pnpm check` fails on any diff under
 * generated/. Two things would otherwise vary: pg_dump stamps a random `\restrict` key into every
 * dump, so we fix it; and it records its own version, so compose.yml pins the image patch release.
 */
function dumpSchema(url: string): void {
  const target = new URL(url)
  const sql = capture('docker', [
    'compose',
    'exec',
    '--no-TTY',
    SERVICE,
    'pg_dump',
    `--username=${target.username}`,
    `--dbname=${target.pathname.slice(1)}`,
    '--schema-only',
    // Whether `public` carries a comment depends on how the database was made, not on any
    // migration: dbmate's `create` leaves one, `createdb` and a hand-made database do not. Dumped,
    // it makes the file say something about the machine it came from — and the drift check then
    // fails on a fresh database for a reason no migration could ever fix.
    '--no-comments',
    '--no-owner',
    '--no-privileges',
    // dbmate's bookkeeping is not part of our schema.
    '--exclude-table=schema_migrations',
    `--restrict-key=${RESTRICT_KEY}`,
  ])
  writeFileSync(SCHEMA, sql)
}

function migrationCount(): number {
  const directory = join(ROOT, MIGRATIONS)
  mkdirSync(directory, { recursive: true })
  return readdirSync(directory).filter((name) => name.endsWith('.sql')).length
}

/**
 * Applies every committed migration to whatever `DATABASE_URL` names, and nothing else.
 *
 * The whole of what a release has to do, and the only part of this file that runs anywhere but a
 * developer's machine: no container to start, and no schema to dump — a dump is a review artifact
 * and there is nobody reviewing during a deploy.
 *
 * Holding none of them is a state this has to support: before the first migration is written, and
 * dbmate calls that an error rather than a no-op.
 */
export function applyMigrations(url: string): void {
  if (migrationCount() === 0) return

  run(binary('dbmate'), [
    '--url',
    url,
    '--migrations-dir',
    MIGRATIONS,
    '--no-dump-schema',
    // A database that is still starting is the ordinary case in a deploy, where this and the
    // server come up together.
    '--wait',
    'up',
  ])
}

/**
 * Returns the URL of a development database that is up and holds every committed migration.
 *
 * The container and the schema dump are what make this the developer's version: `pnpm check`
 * fails on any drift under generated/, and that file is written here.
 */
export function migrate(): string {
  const { DATABASE_URL } = loadEnv()
  mkdirSync(join(ROOT, 'generated'), { recursive: true })

  run('docker', ['compose', 'up', '--detach', '--wait', SERVICE])
  applyMigrations(DATABASE_URL)
  dumpSchema(DATABASE_URL)
  return DATABASE_URL
}

if (process.argv[1] === import.meta.filename) migrate()
