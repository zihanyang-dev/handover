/**
 * Telling a machine there is something for it, without being able to reach it.
 *
 * A machine is behind somebody's router; nothing here can dial it. So it asks — and the whole of
 * this file is making the answer to that question arrive when the answer changes, rather than
 * whenever the machine happens to ask next.
 *
 * The work itself is never carried here. It is in `turns` and `messages`, where it survives
 * everything; what crosses is one machine's id, meaning "look again". A notification nobody was
 * listening for is simply lost, and that costs nothing: the machine asks again anyway, and the
 * question it asks is answered from the tables.
 */

import { sql } from 'kysely'
import { z } from 'zod'
import type { Env } from '../env.ts'
import type { Log } from '../log.ts'
import type { Tx } from './connection.ts'
import { listenOn, type Listening } from './notifications.ts'

/** One name for every machine on every instance; each instance sorts its own out. */
const CHANNEL = 'handover_waiting'

/**
 * Says there is something for this machine, to whichever instance is holding its request.
 *
 * Takes the transaction that wrote the thing, not the pool, and that is the whole point: Postgres
 * delivers a notification when its transaction commits. Sent outside, it could arrive before the
 * row it is about — and a machine woken to find nothing would go back to waiting, having been
 * woken for the one thing it was waiting for.
 */
export async function wakeMachine(tx: Tx, machineId: string): Promise<void> {
  await sql`select pg_notify(${CHANNEL}, ${machineId})`.execute(tx)
}

/** Hears every machine anybody woke, on this instance. A payload that is not one is not one. */
export function listenForWaking(env: Env, log: Log, heard: (machineId: string) => void): Listening {
  return listenOn(env, log, CHANNEL, (payload) => {
    const read = z.uuid().safeParse(payload)
    if (read.success) heard(read.data)
    else log.warn('something that is not a machine was sent on the waking channel')
  })
}
