/**
 * Every database test starts from an empty database.
 *
 * This lives with the test runner rather than under `src/`, because emptying the database is not
 * something the product ever does. The table list is asked of the database: a list written here
 * would be a second copy of the schema, and forgetting to update it would show up as tests
 * quietly sharing rows.
 */

import { sql } from 'kysely'
import { afterAll, beforeEach } from 'vitest'
import { connect } from './src/db/connection.ts'
import { loadEnv } from './src/env.ts'

const db = connect(loadEnv())

beforeEach(async () => {
  const tables = await sql<{ name: string }>`
    select tablename as name from pg_tables
    where schemaname = 'public' and tablename <> 'schema_migrations'
  `.execute(db)

  if (tables.rows.length === 0) return
  const names = tables.rows.map((table) => sql.table(table.name))
  await sql`truncate table ${sql.join(names)} cascade`.execute(db)
})

afterAll(async () => {
  await db.destroy()
})
