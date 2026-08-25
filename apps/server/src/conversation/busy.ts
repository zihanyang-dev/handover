/**
 * Whether a conversation is being worked on right now.
 *
 * Read, never stored, for the same reason presence is: a machine that is killed never gets to
 * write that it stopped, and a stored `working` would sit there forever with nothing to correct
 * it. What is stored is only what was said, and the last thing said answers this.
 */

import type { Presence } from '../machine/presence.ts'
import { ENDINGS } from './transcript.ts'

export type Working =
  /** Nothing is owed. The last turn closed and nobody has said anything since. */
  | { readonly state: 'idle' }
  /** A turn is open on a machine that is here. */
  | { readonly state: 'working' }
  /**
   * A turn is open on a machine that is not here, so what happened on its side is not knowable
   * from here. Deliberately not 'failed': the agent may have finished the whole turn, and saying
   * it failed would invite somebody to ask for it all over again.
   */
  | { readonly state: 'unknown' }

/**
 * The last message in a conversation, or nothing when nobody has said anything yet.
 *
 * Only what kind of activity it was, because that is the only thing that closes a turn. The outer
 * `null` is a separate answer from the inner one: a conversation nobody has spoken into is idle,
 * while one whose last word is a person's is a question waiting to be answered.
 */
export type LastWord = { readonly activityType: string | null } | null

export function working(last: LastWord, machine: Presence): Working {
  if (last === null) return { state: 'idle' }
  if (last.activityType !== null && ENDINGS.includes(last.activityType)) return { state: 'idle' }

  return machine.state === 'here' ? { state: 'working' } : { state: 'unknown' }
}
