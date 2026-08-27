/**
 * The secrets around a machine, and the prefix that says which is which.
 *
 * They are deliberately different things with different lives. An enrolment secret may be pasted
 * onto ten servers by whoever generated it; the credential a machine ends up with belongs to that
 * machine alone. Leaking the first must not be leaking the tenth machine's, and taking one machine
 * away must not take the other nine with it.
 *
 * Only the enrolment secret is minted here. A machine's own credential is minted by the machine —
 * see `collect` — and this side only ever sees its hash. How a secret is made at all is nobody's
 * here: see `src/secret.ts`.
 */

import { mint, type Secret } from '../secret.ts'

const ENROLMENT = 'hk'

/** What a machine shows to collect its credential. Spent the moment it works. */
export function newEnrolmentSecret(): Secret {
  return mint(ENROLMENT)
}
