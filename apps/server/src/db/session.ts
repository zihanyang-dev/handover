/**
 * Reading the session a browser is holding.
 *
 * Expiry and revocation are decided by this query, not by a cleanup job. A job that never runs
 * costs table size; it can never leave a dead session working.
 */

import { sql } from 'kysely'
import { LIFETIME_DAYS } from '../identity/session.ts'
import type { Database } from './connection.ts'

/**
 * Starts a session. Every way in ends here, so a session means the same thing whatever proved it.
 *
 * Named rather than ordered: two unreadable strings side by side, and whichever way round they go
 * the types agree.
 */
export async function openSession(
  db: Database,
  who: { readonly user: string; readonly tokenHash: string },
): Promise<void> {
  await db
    .insertInto('browser_sessions')
    .values({
      user_id: who.user,
      token_hash: who.tokenHash,
      expires_at: sql`now() + make_interval(days => ${LIFETIME_DAYS})`,
    })
    .execute()
}

/** The person whose session this is, or nobody. A revoked or expired session is nobody. */
export async function userHolding(db: Database, tokenHash: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('browser_sessions')
    .select('user_id')
    .where('token_hash', '=', tokenHash)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst()
  return row?.user_id
}

export async function revokeSession(db: Database, tokenHash: string): Promise<void> {
  await db
    .updateTable('browser_sessions')
    .set({ revoked_at: sql`now()` })
    .where('token_hash', '=', tokenHash)
    .where('revoked_at', 'is', null)
    .execute()
}
