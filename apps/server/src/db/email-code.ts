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

/**
 * Whether this caller has already asked for as many codes this hour as it may.
 *
 * Counted per caller rather than across the deployment: a ceiling over everybody is one an
 * attacker can burn through to keep real people from signing in, which trades an uncertain bill
 * for a certain outage. Read in the same transaction that would add to the count.
 *
 * A deployment that cannot tell who is calling counts nobody. That is the honest answer — the
 * alternative is counting a number the caller chose.
 */
async function askedTooOften(
  tx: Tx,
  askedBy: string | null,
  perHour: number,
): Promise<number | undefined> {
  if (askedBy === null) return undefined

  const sofar = await tx
    .selectFrom('email_codes')
    .select((eb) => [
      eb.fn.countAll<number>().as('count'),
      // When the oldest of them falls out of the window, which is when there is room again. Said
      // rather than left to guess: a page that has to invent a number invents the wrong one.
      sql<number>`ceil(extract(epoch from
        min(created_at) + interval '1 hour' - now()))::int`.as('freeIn'),
    ])
    .where('asked_by', '=', askedBy)
    .where('created_at', '>', sql<Date>`now() - interval '1 hour'`)
    .executeTakeFirstOrThrow()

  if (sofar.count < perHour) return undefined

  return Math.max(sofar.freeIn, 1)
}

export type CodeToSend = {
  /** The caller's idempotency key. Retrying with the same one must not send a second mail. */
  readonly requestKey: string
  readonly email: string
  /** What the code is for. Signing in and attaching an address never share one. */
  readonly purpose: Purpose
  readonly codeHash: string
  /**
   * Who asked, as a hash. Null when this deployment cannot honestly tell; `credential-api.ts`
   * works it out.
   */
  readonly askedBy: string | null
}

/**
 * A code that is now out there: when it stops working, and when another may be asked for. Both
 * travel with it so a page can say what this deployment actually does, rather than a number
 * compiled into the page and right only until somebody changes one side.
 */
type IssuedCode = {
  readonly id: string
  readonly expiresAt: Date
  readonly resendAfterSeconds: number
}

export type Issued =
  /** This caller has asked for as many codes this hour as it may. Nothing is wrong with the
   *  address; there is nothing to do but wait, and this says how long. */
  | { readonly kind: 'too-many'; readonly retryAfterSeconds: number }
  | ({ readonly kind: 'issued' } & IssuedCode)
  /**
   * This request already issued one, and a letter for it is in that inbox or may be. The caller
   * must not send another: a second code kills the first, which is the one somebody is reading.
   */
  | ({ readonly kind: 'replayed' } & IssuedCode)
  /** A code went to this address moments ago. Sending now would break the one in the inbox. */
  | { readonly kind: 'too-soon'; readonly retryAfterSeconds: number }
  /** This request already tried, and no letter can reach that address. Saying otherwise is a
   *  person waiting for something that will never arrive. */
  | { readonly kind: 'undeliverable' }

/**
 * How long a send has to have been going before nothing having been recorded means nobody is
 * sending. The mailer gives up on its own after ten seconds and always writes down what happened,
 * so past this the process that was doing it is gone.
 */
const NOBODY_IS_SENDING = sql<boolean>`created_at < now() - interval '30 seconds'`.as('abandoned')

/** The attempt this request already made, if it made one. */
type Attempt = IssuedCode & {
  /** What became of the letter. Null when no attempt has finished. */
  readonly delivery: 'sent' | 'refused' | 'unknown' | null
  /** Nothing was recorded, and long enough has passed that nothing will be. */
  readonly abandoned: boolean
}

/**
 * The code this request already issued, if it issued one.
 *
 * The address and the purpose are part of what makes it the same request. Keyed on the caller's
 * string alone, the same key sent for a different address hands back the first letter's id and
 * expiry and says a code is on its way — to an inbox nothing was ever sent to.
 */
async function replayOf(db: Database, request: CodeToSend): Promise<Attempt | undefined> {
  const found = await db
    .selectFrom('email_codes')
    .select(['id', 'expires_at', 'delivery', WAIT, NOBODY_IS_SENDING])
    .where('request_key', '=', request.requestKey)
    .where('email', '=', request.email)
    .where('purpose', '=', request.purpose)
    .$narrowType<{ delivery: 'sent' | 'refused' | 'unknown' | null }>()
    .executeTakeFirst()

  if (found === undefined) return undefined

  return {
    id: found.id,
    expiresAt: found.expires_at,
    resendAfterSeconds: Math.max(found.wait, 0),
    delivery: found.delivery,
    abandoned: found.abandoned,
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
export async function issueCode(
  db: Database,
  request: CodeToSend,
  /** What this deployment is willing to send in an hour, over every address together. */
  perHour: number,
): Promise<Issued> {
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`${request.purpose}:${request.email}`}))`.execute(
      tx,
    )

    // Before anything is closed. A retry must hand back a working code, and closing first
    // would supersede the very one it is about to return.
    const already = await replayOf(tx, request)
    const answered = replay(already)
    if (answered !== undefined) return answered

    // Left over from an attempt whose process died. Nobody has its code — it only ever existed in
    // memory — so it is not something to hand back, and it is holding this request's name.
    if (already !== undefined)
      await tx.deleteFrom('email_codes').where('id', '=', already.id).execute()

    const wait = await waitLeft(tx, request.email, request.purpose)
    if (wait > 0) return { kind: 'too-soon', retryAfterSeconds: wait }

    // After the replay and the per-address wait, so a retry of something already sent is never
    // refused by a budget it did not spend.
    const freeIn = await askedTooOften(tx, request.askedBy, perHour)
    if (freeIn !== undefined) return { kind: 'too-many', retryAfterSeconds: freeIn }

    await supersede(tx, request)

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
        asked_by: request.askedBy,
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

/**
 * What a repeat of the same request is told, or nothing when there is nothing to repeat.
 *
 * Four situations that used to be one answer. A letter that went and one that may have gone are
 * both "do not send another": a second code kills the first, and the first is the one somebody is
 * reading. A refusal is said out loud rather than dressed as success. And an attempt that recorded
 * nothing and has had long enough is one whose letter will never exist.
 */
function replay(already: Attempt | undefined): Issued | undefined {
  if (already === undefined) return undefined
  if (already.delivery === 'refused') return { kind: 'undeliverable' }
  if (already.delivery === null && already.abandoned) return undefined

  const { delivery: _outcome, abandoned: _stale, ...code } = already
  return { kind: 'replayed', ...code }
}

/**
 * Writes down what became of the letter, once it is known.
 *
 * Outside the transaction that made the code, because it is about something that happened outside
 * the database. Nothing waits on it: a request whose answer is already on its way to a browser
 * must not fail because a bookkeeping write did.
 */
export async function noteDelivery(
  db: Database,
  /** The same three things that make a request that request, so it names the same row. */
  request: Pick<CodeToSend, 'requestKey' | 'email' | 'purpose'>,
  delivery: 'sent' | 'refused' | 'unknown',
): Promise<void> {
  await db
    .updateTable('email_codes')
    .set({ delivery })
    .where('request_key', '=', request.requestKey)
    .where('email', '=', request.email)
    .where('purpose', '=', request.purpose)
    .execute()
}

/**
 * Closes whatever else is open for this address and this purpose.
 *
 * They read as expired rather than wrong: a newer code is out, and the older one is no longer the
 * one in the inbox. A sign-in halfway through is left alone — it is a different letter.
 */
async function supersede(tx: Tx, request: CodeToSend): Promise<void> {
  await tx
    .updateTable('email_codes')
    .set({ closed_at: sql<Date>`clock_timestamp()`, closed_reason: 'superseded' })
    .where('email', '=', request.email)
    .where('purpose', '=', request.purpose)
    .where('closed_at', 'is', null)
    .execute()
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
    .select([
      'email',
      'code_hash',
      'expires_at',
      'attempts',
      'closed_reason',
      // The database's clock, read in the same statement as the row it judges. Two instances whose
      // own clocks disagree would otherwise accept the same code on one and refuse it on the
      // other, and every other deadline in this project is already the database's to decide.
      sql<Date>`now()`.as('asOf'),
    ])
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

  const verdict = checkCode(code, answer.code, secret, row?.asOf ?? new Date())

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
    .set({ closed_at: sql<Date>`clock_timestamp()`, closed_reason: 'consumed' })
    .where('id', '=', answer.codeId)
    .execute()

  return { kind: 'proved', address: verdict.verifiedEmail }
}
