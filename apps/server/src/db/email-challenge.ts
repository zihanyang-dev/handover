/**
 * Persisting the emailed-code challenge that `identity` owns.
 *
 * Locks, in the order every path here takes them:
 *   1. an advisory lock keyed on the address and what the code is for
 *   2. the open challenge row for that address, if there is one
 *
 * The advisory lock is what makes step 2 safe to skip when there is no row yet. Without it, two
 * requests for the same address could both find nothing to close and both insert, and the second
 * would die on the partial unique index instead of getting an answer.
 */

import { sql } from 'kysely'
import {
  LIFETIME_MINUTES,
  RESEND_INTERVAL_SECONDS,
  type Purpose,
} from '../identity/emailed-code.ts'
import type { Database } from './connection.ts'

/** How long until another code may be asked for, by the database's clock and not the caller's. */
const WAIT = sql<number>`ceil(extract(epoch from
  created_at + make_interval(secs => ${RESEND_INTERVAL_SECONDS}) - now()))::int`.as('wait')

export type ChallengeRequest = {
  /** The caller's idempotency key. Retrying with the same one must not send a second mail. */
  readonly requestKey: string
  readonly email: string
  /** What the code is for. Signing in and attaching an address never share one. */
  readonly purpose: Purpose
  readonly codeHash: string
}

/**
 * When it stops working and when another may be asked for. Both travel with the challenge so a
 * page can say what this deployment actually does, rather than a number compiled into it.
 */
export type OpenChallenge = {
  readonly id: string
  readonly expiresAt: Date
  readonly resendAfterSeconds: number
}

export type OpenedChallenge =
  | ({ readonly kind: 'opened' } & OpenChallenge)
  /**
   * This request key already opened a challenge. The mail for it is sent or in flight, so the
   * caller must not send another.
   */
  | ({ readonly kind: 'replayed' } & OpenChallenge)
  /** A code was sent to this address moments ago. Sending now would break the one in the inbox. */
  | { readonly kind: 'too-soon'; readonly retryAfterSeconds: number }

/** The challenge this request key already opened, if it opened one. */
async function replayOf(db: Database, requestKey: string): Promise<OpenChallenge | undefined> {
  const found = await db
    .selectFrom('email_challenges')
    .select(['id', 'expires_at', WAIT])
    .where('request_key', '=', requestKey)
    .executeTakeFirst()

  if (found === undefined) return undefined
  return {
    id: found.id,
    expiresAt: found.expires_at,
    resendAfterSeconds: Math.max(found.wait, 0),
  }
}

/**
 * How long until this address may be sent another code. The clock is the database's: a caller
 * cannot talk its way past this by disagreeing about the time.
 */
async function waitLeft(db: Database, email: string, purpose: Purpose): Promise<number> {
  const open = await db
    .selectFrom('email_challenges')
    .select(WAIT)
    .where('email', '=', email)
    .where('purpose', '=', purpose)
    .where('closed_at', 'is', null)
    .executeTakeFirst()

  return Math.max(open?.wait ?? 0, 0)
}

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
    await sql`select pg_advisory_xact_lock(hashtext(${`${request.purpose}:${request.email}`}))`.execute(
      tx,
    )

    // Before anything is closed. A retry must hand back a working challenge, and closing first
    // would supersede the very one it is about to return.
    const replayed = await replayOf(tx, request.requestKey)
    if (replayed !== undefined) return { kind: 'replayed', ...replayed }

    const wait = await waitLeft(tx, request.email, request.purpose)
    if (wait > 0) return { kind: 'too-soon', retryAfterSeconds: wait }

    // Whatever else is open for this address and this purpose is now stale, and reads as expired
    // rather than wrong. A sign-in halfway through is left alone: it is a different letter.
    await tx
      .updateTable('email_challenges')
      .set({ closed_at: sql`now()`, closed_reason: 'superseded' })
      .where('email', '=', request.email)
      .where('purpose', '=', request.purpose)
      .where('closed_at', 'is', null)
      .execute()

    // No conflict handling on the key: the advisory lock already serialised every retry that
    // shares this address, so reaching here with a spent key means the caller reused one for a
    // different address. That is its bug, and it should hear about it.
    const opened = await tx
      .insertInto('email_challenges')
      .values({
        email: request.email,
        purpose: request.purpose,
        code_hash: request.codeHash,
        request_key: request.requestKey,
        expires_at: sql`now() + make_interval(mins => ${LIFETIME_MINUTES})`,
      })
      .returning(['id', 'expires_at'])
      .executeTakeFirstOrThrow()

    return {
      kind: 'opened',
      id: opened.id,
      expiresAt: opened.expires_at,
      resendAfterSeconds: RESEND_INTERVAL_SECONDS,
    }
  })
}
