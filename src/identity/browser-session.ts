/** The token a browser holds, and how long holding it counts for. */

import { createHash, randomBytes } from 'node:crypto'

/** Long enough not to nag, short enough that a forgotten laptop stops being a way in. */
export const LIFETIME_DAYS = 30

const TOKEN_BYTES = 32

export type SessionToken = {
  /** Goes to the browser in a cookie and is never stored. */
  readonly token: string
  /** Goes to the database. Losing the table does not hand anyone a working session. */
  readonly hash: string
}

/**
 * A plain digest is enough here, unlike an emailed code: the token has 256 bits of entropy, so
 * there is no small set of candidates to try the digest against.
 */
export function newSessionToken(): SessionToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  return { token, hash: hashSessionToken(token) }
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
