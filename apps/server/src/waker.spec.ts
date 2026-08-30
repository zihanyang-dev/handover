/**
 * The one thing on this side that starts on its own.
 *
 * What is under test is that it is a waker and not a scheduler: it looks, and it keeps looking —
 * including when the round it just ran threw, because a moment that is past stays past and the
 * next round finds it.
 */

import { pino } from 'pino'
import { afterAll, describe, expect, it } from 'vitest'
import { connect, type Database } from './db/connection.ts'
import { loadEnv } from './env.ts'
import { LOG_OPTIONS } from './log.ts'
import { keepWaking } from './waker.ts'

const env = loadEnv()
const db: Database = connect(env)
const quiet = pino(LOG_OPTIONS, { write: () => undefined })

afterAll(async () => {
  await db.destroy()
})

/** A database that is not there, and counts how many times it was asked anyway. */
function gone(untilRounds: number, done: () => void) {
  let asked = 0

  return {
    rounds: () => asked,
    db: {
      transaction: () => ({
        execute: async () => {
          asked += 1
          if (asked >= untilRounds) done()
          throw new Error('the database is not there')
        },
      }),
    } as unknown as Database,
  }
}

describe('looking for work whose moment has come', () => {
  it('keeps looking after a round throws, because the next round asks the same thing', async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    const broken = gone(3, resolve)
    const waker = keepWaking(broken.db, quiet, 1)

    await promise
    await waker.stop()

    expect(broken.rounds()).toBeGreaterThanOrEqual(3)
  })

  /**
   * A round that outlasts the gap must delay the next one, not run beside it.
   *
   * On a `setInterval` it did run beside it, and a third joined them — rounds piling up exactly
   * when the database was slowest, which is the one time this should be asking less. Both rounds
   * are idempotent, so what piled up was waste rather than damage; waste that grows on its own is
   * still the shape of an outage.
   */
  it('runs one round at a time, however long a round takes', async () => {
    let inside = 0
    let mostAtOnce = 0
    let finished = 0
    const { promise, resolve } = Promise.withResolvers<void>()

    const slow = {
      transaction: () => ({
        execute: async () => {
          inside += 1
          mostAtOnce = Math.max(mostAtOnce, inside)
          await new Promise((done) => setTimeout(done, 12))
          inside -= 1
          finished += 1
          if (finished >= 4) resolve()
          throw new Error('the database is not there')
        },
      }),
    } as unknown as Database

    // A gap far shorter than a round: on an interval this is what overlap looks like.
    const waker = keepWaking(slow, quiet, 1)
    await promise
    await waker.stop()

    expect(mostAtOnce).toBe(1)
  })

  it('stops when it is told to', async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    const broken = gone(1, resolve)
    const waker = keepWaking(broken.db, quiet, 1)
    await promise

    await waker.stop()
    const after = broken.rounds()
    await new Promise((wake) => setTimeout(wake, 20))

    expect(broken.rounds()).toBe(after)
  })
})
