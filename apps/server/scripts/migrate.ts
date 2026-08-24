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
 * Returns the URL of a database that is up and holds every committed migration.
 *
 * Holding none of them is a state this has to support: before the first migration is written, and
 * dbmate calls that an error rather than a no-op.
 */
export function migrate(): string {
  const { DATABASE_URL } = loadEnv()
  mkdirSync(join(ROOT, 'generated'), { recursive: true })

  run('docker', ['compose', 'up', '--detach', '--wait', SERVICE])
  if (migrationCount() > 0) {
    run(binary('dbmate'), [
      '--url',
      DATABASE_URL,
      '--migrations-dir',
      MIGRATIONS,
      '--no-dump-schema',
      '--wait',
      'up',
    ])
  }
  dumpSchema(DATABASE_URL)
  return DATABASE_URL
}

if (process.argv[1] === import.meta.filename) migrate()
