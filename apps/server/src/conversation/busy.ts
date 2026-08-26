/**
 * Whether a conversation is being worked on right now.
 *
 * Two facts and no guessing: whether a question is still unanswered, and whether the machine that
 * would answer it is here. Neither is stored as a state — a machine that is killed never gets to
 * write that it stopped, and a stored `working` would sit there forever with nothing to correct it.
 */

import type { Presence } from '../machine/presence.ts'

export type Working =
  /** Nothing is owed. Every question has been answered, and nobody has asked another. */
  | { readonly state: 'idle' }
  /** A question is outstanding on a machine that is here — waiting to be taken, or being run. */
  | { readonly state: 'working' }
  /**
   * A question is outstanding on a machine that is not here, so what happened on its side is not
   * knowable from here. Deliberately not 'failed': the agent may have finished the whole turn, and
   * saying it failed would invite somebody to ask for it all over again.
   */
  | { readonly state: 'unknown' }

/**
 * `owed` is a question with no answer yet: one no machine has taken, or one a machine took and
 * has not ended. The difference matters to the machine and to nobody else — from here both are
 * "it is still owed an answer".
 */
export function working(owed: boolean, machine: Presence): Working {
  if (!owed) return { state: 'idle' }

  return machine.state === 'here' ? { state: 'working' } : { state: 'unknown' }
}
