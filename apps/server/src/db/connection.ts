/** Opening the pool a process talks to Postgres through. */

import { Kysely, PostgresDialect, type Transaction } from 'kysely'
import { Pool } from 'pg'
import type { DB } from '../../generated/db.ts'
import type { Env } from '../env.ts'

export type Database = Kysely<DB>

/**
 * An open transaction, for anything that only works inside one.
 *
 * `pg_advisory_xact_lock` is released when the transaction ends, so handed the pool instead, it
 * is taken and let go by the same statement and protects nothing. Nothing about that shows up at
 * runtime — the code runs, the race just comes back. Naming the type is what makes it a compile
 * error rather than a comment somebody has to have read.
 */
export type Tx = Transaction<DB>

export function connect(env: Env): Database {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    // Waiting forever for a connection turns a database under load into a pile of requests that
    // never answer. Failing is something a load balancer can act on; hanging is not.
    connectionTimeoutMillis: 5_000,
  })
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
}
