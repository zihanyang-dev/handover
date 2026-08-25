/**
 * Live moments across more than one server.
 *
 * The case this exists for: a machine posts to whichever instance answered it, and the browser is
 * watching on whichever instance answered that. Nothing in one process's memory can reach the
 * other, so what carries them is Postgres — and this is the test that says it does.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { Moment } from '../conversation/live.ts'
import { loadEnv } from '../env.ts'
import { createLog } from '../log.ts'
import { connect, type Database } from './connection.ts'
import { handTo, listenForMoments, liveThrough } from './live.ts'

const env = loadEnv()
const log = createLog({ ...env, LOG_LEVEL: 'fatal' })

/** Two pools are two processes as far as Postgres is concerned. */
const machineSide: Database = connect(env)
const browserSide: Database = connect(env)

const watching = new Map<string, Set<(moment: Moment) => void>>()
const listening = listenForMoments(env, log, (happening) => {
  handTo(watching, happening)
})
const live = liveThrough(browserSide, watching)

afterAll(async () => {
  await listening.stop()
  await machineSide.destroy()
  await browserSide.destroy()
})

/** What the browser saw, or nothing if it never arrived. */
async function seen(conversationId: string, within = 3000): Promise<Moment | undefined> {
  return new Promise((settle) => {
    const stop = live.watch(conversationId, (moment) => {
      stop()
      settle(moment)
    })
    setTimeout(() => {
      stop()
      settle(undefined)
    }, within).unref()
  })
}

describe('a moment on one instance', () => {
  it('reaches somebody watching on another', async () => {
    const conversationId = randomUUID()
    const arriving = seen(conversationId)

    await liveThrough(machineSide, new Map()).say({
      conversationId,
      moment: { said: 'thinking', text: 'let me look at the file' },
    })

    expect(await arriving).toEqual({ said: 'thinking', text: 'let me look at the file' })
  })

  it('reaches nobody who is watching a different conversation', async () => {
    const arriving = seen(randomUUID(), 500)

    await liveThrough(machineSide, new Map()).say({
      conversationId: randomUUID(),
      moment: { said: 'text', text: 'not for you' },
    })

    expect(await arriving).toBeUndefined()
  })

  it('is cut rather than refused when it is longer than a notification may be', async () => {
    // Postgres refuses a payload over 8000 bytes, and a refused notify would take down the write
    // that carried it. What is watched is a turn in motion; the settled words are on their way to
    // the transcript regardless.
    const conversationId = randomUUID()
    const arriving = seen(conversationId)

    await liveThrough(machineSide, new Map()).say({
      conversationId,
      moment: { said: 'text', text: 'x'.repeat(20_000) },
    })

    const moment = await arriving
    expect(moment?.said).toBe('text')
    expect(moment !== undefined && 'text' in moment && moment.text.length).toBeLessThan(2000)
  })
})
