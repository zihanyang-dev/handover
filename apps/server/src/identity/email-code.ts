/**
 * The rules of a code sent to an address: how long it lasts, how many tries it gets, and what a
 * submission of it means.
 *
 * The five answers are five different things the person should do next, so they stay five values.
 * `consumed` and `code-mismatch` in particular never merge: being told a code was already used is
 * being told that someone may have signed in with it.
 *
 * Public wording is not decided here. This owner states what happened; transport says it.
 */

import { Buffer } from 'node:buffer'
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'

/** Why a code stopped working: spent by a sign-in, or replaced by a newer code. */
export type ClosedReason = 'consumed' | 'superseded'

export type SentCode = {
  /** The address it was sent to. A code means nothing apart from its address. */
  readonly email: string
  readonly codeHash: string
  readonly expiresAt: Date
  readonly attempts: number
  readonly closedReason: ClosedReason | null
}

export type Rejection =
  /** The code is gone; there is nothing to go back to but the start. */
  | 'no-code'
  /** Someone already signed in with this code. */
  | 'consumed'
  /** Too old, or replaced by a newer code. Ask for another. */
  | 'expired'
  /** Guessed at too many times. That code is finished; start again from the inbox. */
  | 'attempts-exhausted'
  /** Wrong digits. The code still works, so it is worth another try. */
  | 'code-mismatch'

export type Verification =
  /** Accepting a code is what proves the address, so the proof travels with the answer. */
  | { readonly kind: 'accepted'; readonly verifiedEmail: string }
  | { readonly kind: 'rejected'; readonly rejection: Rejection }

/** Six digits is a small space, so guessing has to be bounded by tries rather than by the space. */
export const MAX_ATTEMPTS = 5

/** Long enough to go find a mail app, short enough that a code seen over a shoulder goes stale. */
/**
 * What a letter is for. Not how strong it is — both prove the same address to the same standard.
 * They stay apart so a code somebody was talked into forwarding cannot be spent on the other
 * thing, and so asking to attach an address does not quietly kill a sign-in halfway through.
 */
export const PURPOSES = ['sign-in', 'attach'] as const

export type Purpose = (typeof PURPOSES)[number]

export const LIFETIME_MINUTES = 5

/**
 * How long a fresh code has to be given before another one is worth sending. Short enough that
 * somebody who never got the mail is not stuck, long enough that a second click does not put a
 * second code in the inbox and make the first one stop working.
 */
export const RESEND_INTERVAL_SECONDS = 30

export const DIGITS = 6
const RANGE = 10 ** DIGITS

/**
 * What the letter says.
 *
 * The words live with the concept, not with whoever delivers them. A delivery adapter that also
 * wrote the copy would be two jobs in one place, and the copy would be the one nobody reviewed.
 */
export function codeLetter(code: string): { readonly subject: string; readonly text: string } {
  return {
    subject: `${code} is your Handover code`,
    text: [
      `Your code is ${code}.`,
      ``,
      `It works for ${String(LIFETIME_MINUTES)} minutes, and only the newest one works.`,
      `If you did not ask for it, you can ignore this — nobody can get in without it.`,
    ].join('\n'),
  }
}

/** Six digits, drawn without the bias that taking a remainder would introduce. */
export function newCode(): string {
  return String(randomInt(0, RANGE)).padStart(DIGITS, '0')
}

/**
 * Keyed, not plain. A code has only a million possible values, so a bare digest of one is a
 * lookup away from the code itself; without the secret a stolen table is useless.
 *
 * The address goes in too, so a hash only means anything for the person it was sent to. The two
 * are length-prefixed rather than separated by a character: a separator only works while no input
 * can contain it, and that is an assumption about addresses this has no reason to make.
 */
export function hashCode(email: string, code: string, secret: string): string {
  const claim = `${String(email.length)}:${email}${code}`
  return createHmac('sha256', secret).update(claim).digest('hex')
}

function rejected(rejection: Rejection): Verification {
  return { kind: 'rejected', rejection }
}

/** Hashes are fixed width, so the length check leaks nothing that varies. */
function sameHash(submitted: string, stored: string): boolean {
  const left = Buffer.from(submitted)
  const right = Buffer.from(stored)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Hashing happens here rather than at the call site, so no caller can key a code to the wrong
 * address and get a mismatch it cannot explain.
 *
 * Order matters. A spent or replaced code is answered as such even when the digits are wrong,
 * because what the person needs to know is that this code is finished, not that they mistyped it.
 */
export function checkCode(
  /** What was sent, as the database has it, or nothing if there is no such code. */
  sent: SentCode | undefined,
  /** What was typed back. */
  submitted: string,
  secret: string,
  now: Date,
): Verification {
  if (sent === undefined) return rejected('no-code')
  if (sent.closedReason === 'consumed') return rejected('consumed')
  // A code that a newer one replaced is spent, and the recovery is the one an expired code gets.
  if (sent.closedReason === 'superseded') return rejected('expired')
  if (sent.expiresAt.getTime() <= now.getTime()) return rejected('expired')
  if (sent.attempts >= MAX_ATTEMPTS) return rejected('attempts-exhausted')
  if (!sameHash(hashCode(sent.email, submitted, secret), sent.codeHash)) {
    return rejected('code-mismatch')
  }
  return { kind: 'accepted', verifiedEmail: sent.email }
}
