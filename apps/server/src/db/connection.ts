/**
 * Opening the pool a process talks to Postgres through.
 *
 * ## Which clock a column gets
 *
 * Postgres has two and they are not interchangeable. `now()` is the instant the *transaction*
 * began and does not move while it runs; `clock_timestamp()` is the wall clock and does. A
 * transaction that reads, thinks, and then writes gets two different answers from them.
 *
 * **A moment gets `clock_timestamp()`** — `approved_at`, `revoked_at`, `left_at`, `ended_at`.
 * These say when something happened, and the transaction's start time can put a row earlier than
 * something that really happened before it.
 *
 * **A deadline and a reading get `now()`** — `expires_at > now()`, and the `asOf` a screen is
 * shown beside. Every statement in one transaction wants the *same* instant, so two reads in it
 * cannot disagree about what time it is.
 *
 * Written here because the rule was already being broken in four places: `revoked_at` was
 * stamped with both, in two files, and so was `ended_at`. `rules/clocks.spec.ts` asks it now, so
 * neither spelling can look right on its own again.
 */

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
