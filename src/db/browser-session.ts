/**
 * Reading the session a browser is holding.
 *
 * Expiry and revocation are decided by this query, not by a cleanup job. A job that never runs
 * costs table size; it can never leave a dead session working.
 */

import { sql } from 'kysely'
import { LIFETIME_DAYS } from '../identity/browser-session.ts'
import type { Database } from './connection.ts'

/** Starts a session. Every way in ends here, so a session means the same thing whatever proved it. */
export async function openSession(
  db: Database,
  userId: string,
  tokenHash: string,
): Promise<string> {
  const session = await db
    .insertInto('browser_sessions')
    .values({
      user_id: userId,
      token_hash: tokenHash,
      expires_at: sql`now() + make_interval(days => ${LIFETIME_DAYS})`,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return session.id
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
