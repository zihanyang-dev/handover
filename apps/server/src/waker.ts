/**
 * Telling the machines whose moment has come.
 *
 * Waiting out a moment needs no scheduler: what a piece of work is waiting for is the clock, and
 * the clock arrives on its own. The only thing that has to be told is the machine, which is
 * holding a request open and would otherwise sit there until it timed out.
 *
 * So this writes the state and wakes the machine, and does nothing else — no queue, no leases, no
 * second piece of infrastructure. Every instance runs one, they all run the same statement, and
 * only the one whose update touches a row has anything to tell: the rest find nothing due.
 */

import type { Database } from './db/connection.ts'
import { tellWhoeverIsWaitingOnAGoneMachine, wakeWhoseTimeHasCome } from './db/task.ts'
import type { Log } from './log.ts'

/**
 * How often to look.
 *
 * Ten seconds against a moment somebody named in hours or days. Finer buys nothing a person could
 * notice, and the machine it wakes may be asleep anyway — a moment that arrives while nobody is
 * connected is acted on when they come back, which is true of everything else here too.
 */
const EVERY_MS = 10_000

export type Waker = {
  /**
   * Stops looking, and waits for the round in flight.
   *
   * Waiting is the half that matters at shutdown. `main.ts` closes the pool once nothing is using
   * it any more, and a round that was still running was still using it — `code-style.md` 8 asks
   * whoever registers a timer to own its cancel *and* its wait.
   */
  readonly stop: () => Promise<void>
}

export function keepWaking(db: Database, log: Log, everyMs = EVERY_MS): Waker {
  let going = true
  let waiting: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined

  const round = async (): Promise<void> => {
    try {
      const woken = await wakeWhoseTimeHasCome(db)
      if (woken > 0) log.info({ woken }, 'woke work whose moment had come')

      // The other thing that arrives without anybody doing it: a machine stops answering, and
      // whatever handed work to it is waiting on something that will never move again.
      const told = await tellWhoeverIsWaitingOnAGoneMachine(db)
      if (told > 0) log.info({ told }, 'said that a machine holding somebody up has gone')
    } catch (trouble: unknown) {
      // Nothing to recover: the next round asks the same questions, and a moment that is past
      // stays past. Said once rather than thrown at a process that has nobody to throw to.
      log.error({ err: trouble }, 'could not look for work that has come due')
    }
  }

  /**
   * One round, then the next — rather than a beat that fires whether or not the last one is done.
   *
   * On an interval, a round that outlasts the gap does not delay the next one: it runs beside it,
   * and a third joins them, and they pile up exactly when the database is slowest, which is the
   * one time this should be asking *less*. Both rounds are idempotent, so what piled up was
   * waste rather than damage — but waste that grows on its own is the shape of an outage.
   */
  const keepLooking = (): void => {
    if (!going) return

    // Never what keeps this process alive: a deploy should not wait out a beat.
    waiting = setTimeout(() => {
      inFlight = round().finally(() => {
        inFlight = undefined
        keepLooking()
      })
    }, everyMs).unref()
  }

  keepLooking()

  return {
    stop: async () => {
      going = false
      clearTimeout(waiting)
      await inFlight
    },
  }
}
