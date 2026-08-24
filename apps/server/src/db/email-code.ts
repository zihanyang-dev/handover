/**
 * The row for a code we emailed: issuing one, and spending it.
 *
 * Both halves live here because they are the same row's two moments, and because whether a code
 * can still be spent is decided entirely by what issuing wrote — the purpose, the expiry, and
 * whether a newer one has since replaced it.
 *
 * Locks, in the order every path here takes them:
 *   1. an advisory lock keyed on the address and what the code is for
 *   2. the live row for that address and purpose, if there is one
 *
 * The advisory lock is what makes step 2 safe to skip when there is no row yet. Without it, two
 * requests for the same address could both find nothing to close and both insert, and the second
 * would die on the partial unique index instead of getting an answer.
 */

import { sql } from 'kysely'
import {
  checkCode,
  LIFETIME_MINUTES,
  RESEND_INTERVAL_SECONDS,
  type ClosedReason,
  type Purpose,
  type Rejection,
} from '../identity/email-code.ts'
import type { Database, Tx } from './connection.ts'

/** How long until another code may be asked for, by the database's clock and not the caller's. */
const WAIT = sql<number>`ceil(extract(epoch from
  created_at + make_interval(secs => ${RESEND_INTERVAL_SECONDS}) - now()))::int`.as('wait')

export type CodeToSend = {
  /** The caller's idempotency key. Retrying with the same one must not send a second mail. */
  readonly requestKey: string
  readonly email: string
  /** What the code is for. Signing in and attaching an address never share one. */
  readonly purpose: Purpose
  readonly codeHash: string
}

/**
 * A code that is now out there: when it stops working, and when another may be asked for. Both
 * travel with it so a page can say what this deployment actually does, rather than a number
 * compiled into the page and right only until somebody changes one side.
 */
export type IssuedCode = {
  readonly id: string
  readonly expiresAt: Date
  readonly resendAfterSeconds: number
}

export type Issued =
  | ({ readonly kind: 'issued' } & IssuedCode)
  /**
   * This request key already issued one. The mail for it is sent or in flight, so the caller must
   * not send another.
   */
  | ({ readonly kind: 'replayed' } & IssuedCode)
  /** A code went to this address moments ago. Sending now would break the one in the inbox. */
  | { readonly kind: 'too-soon'; readonly retryAfterSeconds: number }

/** The code this request key already issued, if it issued one. */
async function replayOf(db: Database, requestKey: string): Promise<IssuedCode | undefined> {
  const found = await db
    .selectFrom('email_codes')
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
    .selectFrom('email_codes')
    .select(WAIT)
    .where('email', '=', email)
    .where('purpose', '=', purpose)
    .where('closed_at', 'is', null)
    .executeTakeFirst()

  return Math.max(open?.wait ?? 0, 0)
}

/**
 * Opens a code, hands back the one this request key already opened, or says to wait.
 *
 * Sending the mail happens after this commits, never inside it: a code that exists without
 * its mail can be resent, while mail sent for a code that rolled back cannot be recalled.
 */
export async function issueCode(db: Database, request: CodeToSend): Promise<Issued> {
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`${request.purpose}:${request.email}`}))`.execute(
      tx,
    )

    // Before anything is closed. A retry must hand back a working code, and closing first
    // would supersede the very one it is about to return.
    const replayed = await replayOf(tx, request.requestKey)
    if (replayed !== undefined) return { kind: 'replayed', ...replayed }

    const wait = await waitLeft(tx, request.email, request.purpose)
    if (wait > 0) return { kind: 'too-soon', retryAfterSeconds: wait }

    // Whatever else is open for this address and this purpose is now stale, and reads as expired
    // rather than wrong. A sign-in halfway through is left alone: it is a different letter.
    await tx
      .updateTable('email_codes')
      .set({ closed_at: sql`now()`, closed_reason: 'superseded' })
      .where('email', '=', request.email)
      .where('purpose', '=', request.purpose)
      .where('closed_at', 'is', null)
      .execute()

    // No conflict handling on the key: the advisory lock already serialised every retry that
    // shares this address, so reaching here with a spent key means the caller reused one for a
    // different address. That is its bug, and it should hear about it.
    const opened = await tx
      .insertInto('email_codes')
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
      kind: 'issued',
      id: opened.id,
      expiresAt: opened.expires_at,
      resendAfterSeconds: RESEND_INTERVAL_SECONDS,
    }
  })
}

/** Which letter is being answered, and with what. */
export type Answer = {
  readonly purpose: Purpose
  readonly codeId: string
  readonly code: string
}

export type Spent =
  | { readonly kind: 'proved'; readonly address: string }
  | { readonly kind: 'rejected'; readonly rejection: Rejection }

export async function spendCode(tx: Tx, secret: string, answer: Answer): Promise<Spent> {
  const row = await tx
    .selectFrom('email_codes')
    .select(['email', 'code_hash', 'expires_at', 'attempts', 'closed_reason'])
    .where('id', '=', answer.codeId)
    // A code sent to sign in is not a code sent to add an address. Looked up without this, one
    // could be spent on the other, and somebody talked into forwarding a code would have handed
    // over the wrong thing entirely.
    .where('purpose', '=', answer.purpose)
    .forUpdate()
    .executeTakeFirst()

  const code =
    row === undefined
      ? undefined
      : {
          email: row.email,
          codeHash: row.code_hash,
          expiresAt: row.expires_at,
          attempts: row.attempts,
          closedReason: row.closed_reason as ClosedReason | null,
        }

  const verdict = checkCode(code, answer.code, secret, new Date())

  if (verdict.kind === 'rejected') {
    // Only a wrong guess costs a try. The others are already final, and counting them would burn
    // the tries of somebody who is being told the code is over.
    if (verdict.rejection === 'code-mismatch') {
      await tx
        .updateTable('email_codes')
        .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
        .where('id', '=', answer.codeId)
        .execute()
    }
    return { kind: 'rejected', rejection: verdict.rejection }
  }

  await tx
    .updateTable('email_codes')
    .set({ closed_at: sql`now()`, closed_reason: 'consumed' })
    .where('id', '=', answer.codeId)
    .execute()

  return { kind: 'proved', address: verdict.verifiedEmail }
}
