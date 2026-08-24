/**
 * Rebuilds everything under generated/ from the database itself: the schema dump that makes drift
 * visible in review, and the Kysely types. `pnpm check` reruns this and fails on any diff.
 */

import { writeContract } from './contract.ts'
import { loadEnv } from '../src/env.ts'
import { migrate } from './migrate.ts'
import { binary, run } from './run-command.ts'

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

writeContract(loadEnv())

// The browser's view of the contract. Derived, like everything else under generated/.
run(binary('openapi-typescript'), ['generated/openapi.json', '-o', 'web/generated/api.ts'])

// The route tree, read off the filesystem. Not committed: its source already is.
run(binary('tsr'), ['generate'])
