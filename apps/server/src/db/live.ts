/**
 * Carrying live moments between server instances.
 *
 * A machine posts to whichever instance answered it; a browser is watching on whichever instance
 * answered that. In a fleet those are usually not the same process, and nothing in a process's
 * memory can reach the other one.
 *
 * Postgres already stands between every instance and is already the thing this system trusts, so
 * `NOTIFY` carries them: no second piece of infrastructure to run, and nothing to keep in sync.
 * It is deliberately not the transcript — a notification nobody was listening for is simply gone,
 * which is exactly right for something that is only worth anything while it is happening.
 */

import { sql } from 'kysely'
import { Happening, type Live, type Watched } from '../conversation/live.ts'
import type { Env } from '../env.ts'
import type { Log } from '../log.ts'
import type { Database, Tx } from './connection.ts'
import { listenOn, type Listening } from './notifications.ts'

/** One name for everything live, and each instance sorts its own watchers out. */
const CHANNEL = 'handover_live'

/**
 * Postgres refuses a payload over 8000 bytes, and a refused one would answer a machine that was
 * only saying what it is doing with a fault. Only what an agent is thinking can come near that,
 * and cutting it costs nothing: it is worth something for a second and is kept nowhere. A mark
 * saying the transcript has grown is a number.
 */
const ROOM = 6000

function shortened(happening: Happening): Happening {
  if (JSON.stringify(happening).length <= ROOM) return happening
  if (happening.watched.seen !== 'moment') return happening

  const moment = happening.watched.moment
  const cut = (text: string): string => `${text.slice(0, 1000)}…`
  const shorter = moment.said === 'thinking' ? { ...moment, text: cut(moment.text) } : moment

  return { conversationId: happening.conversationId, watched: { seen: 'moment', moment: shorter } }
}

/** Says one thing to every instance, including this one. */
async function announce(db: Database | Tx, happening: Happening): Promise<void> {
  await sql`select pg_notify(${CHANNEL}, ${JSON.stringify(shortened(happening))})`.execute(db)
}

/**
 * Says that a conversation has been written to, in the transaction that wrote it.
 *
 * Takes the transaction rather than the pool, which is the whole of why this is reliable:
 * Postgres delivers a notification when its transaction commits, so nobody can be sent to read a
 * message that is not there yet, and nobody is told about one that rolled back.
 *
 * The write is what says it. Left to the callers, the one that forgot would be a conversation
 * that sat still on somebody's screen while the agent worked, and nothing would say which caller
 * it was.
 */
export async function noteWritten(tx: Tx, conversationId: string, upTo: number): Promise<void> {
  await announce(tx, { conversationId, watched: { seen: 'written', upTo } })
}

/**
 * Hears everything anybody said about a conversation on this deployment.
 *
 * Something this build cannot read is something nobody can act on, and it is gone either way —
 * said in the log once rather than thrown at whoever is watching.
 */
export function listenForLive(
  env: Env,
  log: Log,
  heard: (happening: Happening) => void,
): Listening {
  return listenOn(env, log, CHANNEL, (payload) => {
    const read = Happening.safeParse(JSON.parse(payload === '' ? 'null' : payload))
    if (read.success) heard(read.data)
    else log.warn('something live arrived in a shape this build does not know')
  })
}

/**
 * Everyone watching on this instance.
 *
 * A plain map, because that is all it is: the fan-out across instances is the notification, and
 * what is left here is handing one moment to the browsers this process is holding open.
 */
export function liveThrough(db: Database, watching: Map<string, Set<(watched: Watched) => void>>) {
  return {
    say: async (happening: Happening) => announce(db, happening),

    watch: (conversationId: string, see: (watched: Watched) => void) => {
      const here = watching.get(conversationId) ?? new Set()
      here.add(see)
      watching.set(conversationId, here)

      return () => {
        here.delete(see)
        // The last watcher of a conversation takes its name with it, so a server that has been up
        // for a month is not holding one empty set per conversation anybody ever opened.
        if (here.size === 0) watching.delete(conversationId)
      }
    },
  } satisfies Live
}

/** Hands one thing to the browsers this instance is holding open. */
export function handTo(
  watching: Map<string, Set<(watched: Watched) => void>>,
  happening: Happening,
): void {
  for (const see of watching.get(happening.conversationId) ?? []) see(happening.watched)
}
