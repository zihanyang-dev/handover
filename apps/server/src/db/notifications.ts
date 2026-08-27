/**
 * Hearing one channel of news from the other instances.
 *
 * Two things in this system are worth telling every instance about the moment they happen: a
 * moment in a running turn, and that a machine has something waiting for it. Neither is a fact
 * anybody stores here — the facts are in tables — so what crosses is only ever "go and look".
 *
 * `LISTEN` holds a connection for as long as it is listening, so it cannot come from the pool: a
 * pooled connection is handed back, and the listening goes back with it. That is one connection
 * per channel per instance, which is the price of hearing anything at all without a second piece
 * of infrastructure standing between the instances.
 */

import { Client } from 'pg'
import type { Env } from '../env.ts'
import type { Log } from '../log.ts'

export type Listening = {
  /**
   * Settles once this connection is really listening, the first time.
   *
   * Nothing in the server waits for it — news sent in the first millisecond is news nobody was
   * waiting for either way — but a test that says "one instance says, another hears" has to know
   * when the other one is there.
   */
  readonly listening: Promise<void>
  readonly stop: () => Promise<void>
}

/** How long to wait before trying again, and the ceiling it climbs to. */
const FIRST_WAIT_MS = 1_000

const LONGEST_WAIT_MS = 30_000

/** One channel, and what to do with what comes down it. */
export type Listener = {
  readonly env: Env
  readonly log: Log
  readonly channel: string
  readonly heard: (payload: string) => void
  /**
   * What the caller does about a gap, once this is listening again.
   *
   * Nothing sent while the connection was down can be replayed — Postgres keeps a notification
   * for exactly as long as somebody is there to hear it — so whoever is listening has to go and
   * look instead. The waking channel wakes every question it is holding, and they all ask the
   * tables again.
   */
  readonly again?: () => void
}

/** Everything one listener has to remember between one connection and the next. */
type Trying = {
  client: Client | undefined
  waitMs: number
  retry: NodeJS.Timeout | undefined
  stopped: boolean
  hearing: () => void
}

/**
 * Spread, so a database that comes back does not meet every instance at the same instant.
 *
 * A fleet that all lost the same connection all retry on the same schedule, and the first thing a
 * recovering database would see is every one of them arriving together.
 */
function jittered(wait: number): number {
  return wait * (0.8 + Math.random() * 0.4)
}

/** Waits, then tries again. Doubling, so a database that is down is not also being hammered. */
function later(to: Listener, trying: Trying): void {
  if (trying.stopped || trying.retry !== undefined) return

  trying.retry = setTimeout(() => {
    trying.retry = undefined
    void attach(to, trying, false)
  }, jittered(trying.waitMs))
  // Unreferenced, so a process on its way out is never held open by a wait to try again.
  trying.retry.unref()
  trying.waitMs = Math.min(trying.waitMs * 2, LONGEST_WAIT_MS)
}

/** One connection, from opening it to hearing the first thing on it. */
async function attach(to: Listener, trying: Trying, first: boolean): Promise<void> {
  if (trying.stopped) return

  const fresh = new Client({ connectionString: to.env.DATABASE_URL })
  trying.client = fresh
  fresh.on('notification', (notice) => {
    to.heard(notice.payload ?? '')
  })
  // `pg` emits `error` on a connection that has already gone. Reconnecting from in here is what
  // makes the next one a fresh client rather than a second life for a dead one.
  fresh.on('error', (trouble) => {
    to.log.error({ err: trouble, channel: to.channel }, 'a listening connection broke')
    // Whatever closing a connection that has already gone has to say, it is about the break
    // above and is already in the log. What matters next is the one being opened.
    fresh.end().catch(() => undefined)
    if (trying.client === fresh) later(to, trying)
  })

  try {
    await fresh.connect()
    // The channel name cannot be a parameter — it is an identifier, not a value — so it is never
    // anything but one of the constants beside the code that sends on it.
    await fresh.query(`listen ${to.channel}`)
  } catch (trouble) {
    to.log.error({ err: trouble, channel: to.channel }, 'could not listen')
    if (trying.client === fresh) later(to, trying)
    return
  }

  trying.waitMs = FIRST_WAIT_MS
  trying.hearing()
  // Not on the first: there is no gap before anybody was listening, and a caller that went and
  // looked at startup would be answering questions nobody had asked yet.
  if (!first) {
    to.log.info({ channel: to.channel }, 'listening again')
    to.again?.()
  }
}

/**
 * Holds a connection open for one channel, and hands every payload to `heard`.
 *
 * It reconnects, and that is the whole reason this is not four lines. A `LISTEN` connection is
 * broken by things that are ordinary rather than exceptional — a database restart, a failover, a
 * pooler reaping an idle session — and this used to log the break and stop listening for the
 * lifetime of the process. What that costs is not one missed notification: an instance that is
 * deaf for good holds every machine's question for the full hold instead of answering the moment
 * somebody says something, silently, for ever.
 */
export function listenOn(to: Listener): Listening {
  const { promise: listening, resolve: hearing } = Promise.withResolvers<void>()
  const trying: Trying = {
    client: undefined,
    waitMs: FIRST_WAIT_MS,
    retry: undefined,
    stopped: false,
    hearing,
  }

  void attach(to, trying, true)

  return {
    listening,
    stop: async () => {
      trying.stopped = true
      if (trying.retry !== undefined) clearTimeout(trying.retry)
      await trying.client?.end()
    },
  }
}
