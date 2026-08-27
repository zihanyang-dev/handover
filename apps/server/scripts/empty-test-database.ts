/**
 * Empties the test database, leaving its schema alone.
 *
 * CI makes this database from nothing every run, and every local run reuses one that has been
 * accumulating since the day it was created. That difference is invisible until something reads
 * across the whole deployment rather than one Space — and then a test that passes in CI and on a
 * fresh clone takes longer every day here until it times out, for reasons nowhere near itself.
 *
 * Truncating rather than dropping: the schema is what `dbmate` just finished putting there, and
 * re-running the migrations to get an empty database again would be the slow way round.
 *
 * Points only at `DATABASE_URL`, which for this script is always `.env.test`. Emptying anything
 * else would be a very bad afternoon, so it refuses a database that is not named for testing.
 */

import { Pool } from 'pg'
import { loadEnv } from '../src/env.ts'

const env = loadEnv()
const name = new URL(env.DATABASE_URL).pathname.slice(1)

if (!name.endsWith('_test')) {
  throw new Error(`refusing to empty ${name}: this script is only ever pointed at a test database`)
}

const pool = new Pool({ connectionString: env.DATABASE_URL })
const { rows } = await pool.query<{ tables: string }>(`
  select string_agg(format('%I.%I', schemaname, tablename), ', ') as tables
    from pg_tables
   where schemaname = 'public' and tablename <> 'schema_migrations'
`)

const tables = rows[0]?.tables
if (tables !== undefined) await pool.query(`truncate ${tables} restart identity cascade`)

await pool.end()

// Nothing to say when it worked: the migration above already printed, and a script that is quiet
// on success is one whose output is only ever a problem. `log.ts` owns stdout for the server;
// scripts are not the server, and this one has nothing to add.
