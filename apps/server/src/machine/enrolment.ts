/**
 * How long an enrolment stays open, and what can become of one.
 *
 * The states are what a machine polling for its credential is told, so they exist to be told
 * apart: waiting is normal and worth waiting through, the other four each end the attempt for a
 * different reason and send somebody somewhere different.
 */

/**
 * Long enough to walk to another device and read a code off a screen, short enough that a code
 * left on a terminal overnight is not a way in.
 */
export const LIFETIME_MINUTES = 15

export type Enrolment =
  /** Nobody has answered yet. The machine keeps asking. */
  | { readonly kind: 'waiting' }
  /** Somebody said no. Terminal: asking again with the same secret cannot change it. */
  | { readonly kind: 'refused' }
  /** Nobody answered in time. */
  | { readonly kind: 'expired' }
  /**
   * Already collected.
   *
   * Kept apart from "no such enrolment" because it means somebody else got in with this — on the
   * key path a single-use key really can be taken by another machine, and that is worth being
   * told rather than being called a typo.
   */
  | { readonly kind: 'spent' }
  | { readonly kind: 'no-enrolment' }
