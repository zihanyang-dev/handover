/**
 * What is happening in a conversation, across more than one server.
 *
 * The case this exists for: a machine posts to whichever instance answered it, and the browser is
 * watching on whichever instance answered that. Nothing in one process's memory can reach the
 * other, so what carries them is Postgres — and this is the test that says it does.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Watched } from '../conversation/live.ts'
import { loadEnv } from '../env.ts'
import { createLog } from '../log.ts'
import { connect, type Database } from './connection.ts'
import { handTo, listenForLive, liveThrough } from './live.ts'

const env = loadEnv()
const log = createLog({ ...env, LOG_LEVEL: 'fatal' })

/** Two pools are two processes as far as Postgres is concerned. */
const machineSide: Database = connect(env)
const browserSide: Database = connect(env)

const watching = new Map<string, Set<(watched: Watched) => void>>()
const listening = listenForLive(env, log, (happening) => {
  handTo(watching, happening)
})
const live = liveThrough(browserSide, watching)

beforeAll(async () => {
  // Nothing arrives before the connection is up, and a test that raced it would fail for a reason
  // that has nothing to do with what it is about.
  await listening.listening
})

afterAll(async () => {
  await listening.stop()
  await machineSide.destroy()
  await browserSide.destroy()
})

/** What the browser saw, or nothing if it never arrived. */
async function seen(conversationId: string, within = 3000): Promise<Watched | undefined> {
  return new Promise((settle) => {
    const stop = live.watch(conversationId, (watched) => {
      stop()
      settle(watched)
    })
    setTimeout(() => {
      stop()
      settle(undefined)
    }, within).unref()
  })
}

describe('something said on one instance', () => {
  it('reaches somebody watching on another', async () => {
    const conversationId = randomUUID()
    const arriving = seen(conversationId)

    await liveThrough(machineSide, new Map()).say({
      conversationId,
      watched: { seen: 'moment', moment: { said: 'thinking', text: 'let me look at the file' } },
    })

    expect(await arriving).toEqual({
      seen: 'moment',
      moment: { said: 'thinking', text: 'let me look at the file' },
    })
  })

  it('carries a mark saying the transcript has grown, which is a number and not the words', async () => {
    // The other half of what a watcher is told, and the half that is not a copy of anything: it
    // sends them to read the transcript rather than handing them a second version of it.
    const conversationId = randomUUID()
    const arriving = seen(conversationId)

    await liveThrough(machineSide, new Map()).say({
      conversationId,
      watched: { seen: 'written', upTo: 42 },
    })

    expect(await arriving).toEqual({ seen: 'written', upTo: 42 })
  })

  it('reaches nobody who is watching a different conversation', async () => {
    const arriving = seen(randomUUID(), 500)

    await liveThrough(machineSide, new Map()).say({
      conversationId: randomUUID(),
      watched: { seen: 'moment', moment: { said: 'thinking', text: 'not for you' } },
    })

    expect(await arriving).toBeUndefined()
  })

  it('is cut rather than refused when it is longer than a notification may be', async () => {
    // Postgres refuses a payload over 8000 bytes, and a refused notify would take down the write
    // that carried it. Thinking is the only thing here that can come near it, and cutting it
    // costs nothing — it is worth something for a second and is kept nowhere.
    const conversationId = randomUUID()
    const arriving = seen(conversationId)

    await liveThrough(machineSide, new Map()).say({
      conversationId,
      watched: { seen: 'moment', moment: { said: 'thinking', text: 'x'.repeat(20_000) } },
    })

    const watched = await arriving
    expect(watched?.seen).toBe('moment')
    expect(
      watched?.seen === 'moment' && 'text' in watched.moment && watched.moment.text.length,
    ).toBeLessThan(2000)
  })
})
