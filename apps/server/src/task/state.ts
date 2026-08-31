/**
 * What a piece of work is up to, as far as anything that decides is concerned.
 *
 * Its own module rather than a constant beside the rows, for the reason `machine/at-once.ts` gives
 * about its own: `db/task.ts` owns the rows, and which states exist is not a fact about a row. It
 * is read by the turn handler as well, which has no business importing the table.
 */

/** Four, and no fifth. */
export const STATE = {
  /** Nobody has to do anything for it to move: it should be running, or about to be. */
  working: 'working',
  /** It asked its owner something. Only they can start it again. */
  wait: 'wait',
  /** It is waiting out a moment. Only the clock can start it again. */
  sleep: 'sleep',
  /** Over. Nothing starts it again — a second hand-over is a second piece of work. */
  done: 'done',
} as const

export type State = (typeof STATE)[keyof typeof STATE]
