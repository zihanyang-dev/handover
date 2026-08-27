/**
 * That a listening connection comes back by itself.
 *
 * The one failure this file exists for cannot be reasoned about from the code that breaks: a
 * `LISTEN` connection is ended by things that are ordinary — a database restart, a failover, a
 * pooler reaping an idle session — and what it costs is silent. An instance that stopped
 * listening goes on serving, and every machine's question it holds simply waits out its whole
 * hold instead of being answered the moment somebody says something.
 *
 * So the break is made rather than described: `pg_terminate_backend` on this listener's own
 * connection is exactly what a database restart does to it.
 */

import { sql } from 'kysely'
import { pino } from 'pino'
import { afterAll, describe, expect, it } from 'vitest'
import { loadEnv } from '../env.ts'
import { LOG_OPTIONS } from '../log.ts'
import { connect, type Database } from './connection.ts'
import { listenOn } from './notifications.ts'

const env = loadEnv()

const db: Database = connect(env)

/** These tests break connections on purpose; what is written about it is not the point. */
const silent = pino(LOG_OPTIONS, { write: () => undefined })

const CHANNEL = 'handover_listening_test'

afterAll(async () => {
  await db.destroy()
})

/** Everything Postgres is holding open for this channel, as backend process ids. */
async function listeners(): Promise<readonly number[]> {
  const { rows } = await sql<{ pid: number }>`
    select pid from pg_stat_activity
     where query like ${`listen ${CHANNEL}%`} and pid <> pg_backend_pid()
  `.execute(db)

  return rows.map((one) => one.pid)
}

/** Waits for something, without deciding how long is long enough anywhere but here. */
async function until(itIs: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !itIs(); tries += 1) {
    await new Promise((wake) => setTimeout(wake, 100))
  }
}

describe('a connection that listens', () => {
  it('hears again after the database drops it, and says so to whoever was waiting', async () => {
    const heard: string[] = []
    let came = 0
    const listening = listenOn({
      env,
      log: silent,
      channel: CHANNEL,
      heard: (payload) => heard.push(payload),
      again: () => {
        came += 1
      },
    })

    try {
      await listening.listening
      await sql`select pg_notify(${CHANNEL}, 'first')`.execute(db)
      await until(() => heard.length === 1)
      expect(heard).toEqual(['first'])

      // What a database restart does to it, done on purpose.
      const [pid] = await listeners()
      expect(pid).toBeDefined()
      await sql`select pg_terminate_backend(${pid})`.execute(db)

      // Nothing sent in the gap can be replayed, so what is asked is that it is listening again
      // and that it said so — which is the only reason anybody can go and look.
      await until(() => came === 1)
      expect(came).toBe(1)

      await sql`select pg_notify(${CHANNEL}, 'second')`.execute(db)
      await until(() => heard.length === 2)

      expect(heard).toEqual(['first', 'second'])
    } finally {
      await listening.stop()
    }
  })
})
