/**
 * The secrets around a machine, and the prefixes that say which is which.
 *
 * They are deliberately different things with different lives. An enrolment secret may be pasted
 * onto ten servers by whoever generated it; the credential a machine ends up with belongs to that
 * machine alone. Leaking the first must not be leaking the tenth machine's, and taking one machine
 * away must not take the other nine with it.
 *
 * Only the enrolment secret is minted here. A machine's own credential is minted by the machine —
 * see `collect` — and this side only ever sees its hash.
 */

import { createHash, randomBytes } from 'node:crypto'

const SECRET_BYTES = 32

/**
 * Prefixes so a secret found in a log, a shell history or a pasted snippet says what it is and
 * where to go revoke it. GitHub, Multica and Tailscale all label theirs for the same reason.
 */
const ENROLMENT = 'hk'

export type Secret = {
  /** Handed over once and never stored. */
  readonly secret: string
  /** Goes to the database. Losing the table hands nobody a working machine. */
  readonly hash: string
}

/** What a machine shows to collect its credential. Spent the moment it works. */
export function newEnrolmentSecret(): Secret {
  return mint(ENROLMENT)
}

/**
 * A plain digest, as for a browser session: 256 bits leaves no small set of candidates to try a
 * digest against, which is the only thing a slow hash would buy.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

function mint(prefix: string): Secret {
  const secret = `${prefix}_${randomBytes(SECRET_BYTES).toString('base64url')}`
  return { secret, hash: hashSecret(secret) }
}
