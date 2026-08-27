/**
 * A secret handed out once, of which only the hash is kept.
 *
 * Neutral on purpose. Three different things here need one — a machine's way in, a person's way
 * into a Space, a browser's session — and none of them owns the idea. What each of them does own
 * is its own prefix, which lives beside the thing it names.
 */

import { createHash, randomBytes } from 'node:crypto'

/**
 * 256 bits. Enough that guessing is not a strategy, and the reason a plain digest is enough
 * below: there is no small set of candidates for a slow hash to make expensive.
 */
const SECRET_BYTES = 32

export type Secret = {
  /** Handed over once and never stored. */
  readonly secret: string
  /** Goes to the database. Losing the table hands nobody a working anything. */
  readonly hash: string
}

/**
 * One secret, labelled.
 *
 * The prefix is so a secret found in a log, a shell history or a pasted snippet says what it is
 * and where to go and revoke it. GitHub, Multica and Tailscale all label theirs for that reason.
 */
export function mint(prefix: string): Secret {
  const secret = `${prefix}_${randomBytes(SECRET_BYTES).toString('base64url')}`

  return { secret, hash: hashSecret(secret) }
}

/** A plain digest — see `SECRET_BYTES` for why nothing slower buys anything. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}
