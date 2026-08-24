/**
 * Persisting the emailed-code challenge that `identity` owns.
 *
 * Locks, in the order every path here takes them:
 *   1. an advisory lock keyed on the address
 *   2. the open challenge row for that address, if there is one
 *
 * The advisory lock is what makes step 2 safe to skip when there is no row yet. Without it, two
 * requests for the same address could both find nothing to close and both insert, and the second
 * would die on the partial unique index instead of getting an answer.
 */

import { sql } from 'kysely'
import { LIFETIME_MINUTES, RESEND_INTERVAL_SECONDS } from '../identity/emailed-code.ts'
import type { Database } from './connection.ts'

export type ChallengeRequest = {
  /** The caller's idempotency key. Retrying with the same one must not send a second mail. */
  readonly requestKey: string
  readonly email: string
  readonly codeHash: string
}

export type OpenedChallenge =
  | { readonly kind: 'opened'; readonly id: string }
  /**
   * This request key already opened a challenge. The mail for it is sent or in flight, so the
   * caller must not send another.
   */
  | { readonly kind: 'replayed'; readonly id: string }
  /** A code was sent to this address moments ago. Sending now would break the one in the inbox. */
  | { readonly kind: 'too-soon'; readonly retryAfterSeconds: number }

/**
 * Opens a challenge, hands back the one this request key already opened, or says to wait.
 *
 * Sending the mail happens after this commits, never inside it: a challenge that exists without
 * its mail can be resent, while mail sent for a challenge that rolled back cannot be recalled.
 */
export async function openChallenge(
  db: Database,
  request: ChallengeRequest,
): Promise<OpenedChallenge> {
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${request.email}))`.execute(tx)

    // Before anything is closed. A retry must hand back a working challenge, and closing first
    // would supersede the very one it is about to return.
    const existing = await tx
      .selectFrom('email_challenges')
      .select('id')
      .where('request_key', '=', request.requestKey)
      .executeTakeFirst()

    if (existing !== undefined) return { kind: 'replayed', id: existing.id }

    // Asked before the last code had a chance. The clock is the database's: a caller cannot talk
    // its way past this by disagreeing about the time.
    const recent = await tx
      .selectFrom('email_challenges')
      .select(
        sql<number>`ceil(extract(epoch from
          created_at + make_interval(secs => ${RESEND_INTERVAL_SECONDS}) - now()))::int`.as('wait'),
      )
      .where('email', '=', request.email)
      .where('closed_at', 'is', null)
      .executeTakeFirst()

    if (recent !== undefined && recent.wait > 0) {
      return { kind: 'too-soon', retryAfterSeconds: recent.wait }
    }

    // Whatever else is open for this address is now stale, and reads as expired rather than wrong.
    await tx
      .updateTable('email_challenges')
      .set({ closed_at: sql`now()`, closed_reason: 'superseded' })
      .where('email', '=', request.email)
      .where('closed_at', 'is', null)
      .execute()

    // No conflict handling on the key: the advisory lock already serialised every retry that
    // shares this address, so reaching here with a spent key means the caller reused one for a
    // different address. That is its bug, and it should hear about it.
    const opened = await tx
      .insertInto('email_challenges')
      .values({
        email: request.email,
        code_hash: request.codeHash,
        request_key: request.requestKey,
        expires_at: sql`now() + make_interval(mins => ${LIFETIME_MINUTES})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    return { kind: 'opened', id: opened.id }
  })
}
