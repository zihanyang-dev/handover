/**
 * Rebuilds everything under generated/ from the database itself: the schema dump that makes drift
 * visible in review, and the Kysely types. `pnpm check` reruns this and fails on any diff.
 */

import { binary, run } from './run-command.ts'
import { migrate } from './migrate.ts'

const url = migrate()

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
