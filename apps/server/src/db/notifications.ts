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
   * Settles once this connection is really listening.
   *
   * Nothing in the server waits for it — news sent in the first millisecond is news nobody was
   * waiting for either way — but a test that says "one instance says, another hears" has to know
   * when the other one is there.
   */
  readonly listening: Promise<void>
  readonly stop: () => Promise<void>
}

/**
 * Holds a connection open for one channel, and hands every payload to `heard`.
 *
 * Nothing here can be recovered by the caller: it is a connection this process owns, and what is
 * lost when it breaks is news rather than facts — a browser that stops seeing live moments still
 * has the transcript, and a machine that is not woken still asks again.
 */
export function listenOn(
  env: Env,
  log: Log,
  channel: string,
  heard: (payload: string) => void,
): Listening {
  const client = new Client({ connectionString: env.DATABASE_URL })

  client.on('notification', (notice) => {
    heard(notice.payload ?? '')
  })

  client.on('error', (trouble) => {
    log.error({ err: trouble, channel }, 'a listening connection broke')
  })

  const connected = client
    .connect()
    // The channel name cannot be a parameter — it is an identifier, not a value — so it is never
    // anything but one of the constants beside the code that sends on it.
    .then(async () => client.query(`listen ${channel}`))
    .then(() => undefined)
    .catch((trouble: unknown) => {
      log.error({ err: trouble, channel }, 'could not listen')
    })

  return {
    listening: connected,
    stop: async () => {
      await connected
      await client.end()
    },
  }
}
