/** Opening the pool a process talks to Postgres through. */

import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { DB } from '../../generated/db.ts'
import type { Env } from '../env.ts'

export type Database = Kysely<DB>

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
