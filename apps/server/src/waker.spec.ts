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
    waker.stop()

    expect(broken.rounds()).toBeGreaterThanOrEqual(3)
  })

  it('stops when it is told to', async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    const broken = gone(1, resolve)
    const waker = keepWaking(broken.db, quiet, 1)
    await promise

    waker.stop()
    const after = broken.rounds()
    await new Promise((wake) => setTimeout(wake, 20))

    expect(broken.rounds()).toBe(after)
  })
})
