/**
 * Rebuilds everything under generated/ from the database itself: the schema dump that makes drift
 * visible in review, and the Kysely types. `pnpm check` reruns this and fails on any diff.
 *
 * Into a database of its own, made here and dropped after. Pointed at the development or test
 * database instead, whatever else happens to be in one comes along — and it did: three tables
 * from another branch's work were introspected out of the shared test database and committed
 * here, ninety-one lines of a schema this branch has no migration for. Nothing caught it, because
 * the file matched the database exactly. It was the database that was wrong.
 *
 * A database made from the migrations and nothing else cannot be wrong that way, and it makes
 * this command answer the same on any machine and in CI.
 */

import { loadEnv } from '../src/env.ts'
import { writeContract } from './contract.ts'
import { onlyTheMigrations } from './migrate.ts'
import { binary, repoBinary, run } from './run-command.ts'

const { url, drop } = onlyTheMigrations()

run(binary('kysely-codegen'), [
  '--url',
  url,
  '--dialect',
  'postgres',
  '--out-file',
  'generated/db.ts',
  // dbmate's own bookkeeping table is not part of our schema.
  '--exclude-pattern',
  'schema_migrations',
])

// Formatted here rather than left to `kysely-codegen`, which reaches for prettier if it happens
// to resolve one and writes its own way if it does not. It resolved on a developer's machine and
// not in CI, so the committed file and the one CI rebuilt differed by a semicolon on every line
// — a diff that says nothing and fails the build. `.prettierignore` leaves everything under
// `generated/` alone on purpose; the thing that writes an artefact is the thing that decides how
// it looks.
run(repoBinary('prettier'), ['--write', '--ignore-path', '.prettierignore-none', 'generated/db.ts'])

writeContract(loadEnv())

drop()
