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
import { Happening, type Live, type Moment } from '../conversation/live.ts'
import type { Env } from '../env.ts'
import type { Log } from '../log.ts'
import type { Database } from './connection.ts'
import { listenOn, type Listening } from './notifications.ts'

/** One name for everything live, and each instance sorts its own watchers out. */
const CHANNEL = 'handover_live'

/**
 * Postgres refuses a payload over 8000 bytes, and a refused one would answer a machine that was
 * only saying what it is doing with a fault. Long text is cut rather than dropped: what is
 * watched is a turn in motion, and the settled version of the same words is on its way to the
 * transcript regardless.
 */
const ROOM = 6000

function shortened(happening: Happening): Happening {
  const said = JSON.stringify(happening)
  if (said.length <= ROOM) return happening

  const moment = happening.moment
  const cut = (text: string) => `${text.slice(0, 1000)}…`
  const shorter =
    moment.said === 'did' ? { ...moment, excerpt: cut(moment.excerpt) } : { ...moment }

  return {
    conversationId: happening.conversationId,
    moment: 'text' in shorter ? { ...shorter, text: cut(shorter.text) } : shorter,
  }
}

/** Says one moment to every instance, including this one. */
async function announce(db: Database, happening: Happening): Promise<void> {
  await sql`select pg_notify(${CHANNEL}, ${JSON.stringify(shortened(happening))})`.execute(db)
}

/**
 * Hears every moment.
 *
 * A moment this build cannot read is one nobody can act on, and it is gone in a second either
 * way — said in the log once rather than thrown at whoever is watching.
 */
export function listenForMoments(
  env: Env,
  log: Log,
  heard: (happening: Happening) => void,
): Listening {
  return listenOn(env, log, CHANNEL, (payload) => {
    const read = Happening.safeParse(JSON.parse(payload === '' ? 'null' : payload))
    if (read.success) heard(read.data)
    else log.warn('a live moment arrived in a shape this build does not know')
  })
}

/**
 * Everyone watching on this instance.
 *
 * A plain map, because that is all it is: the fan-out across instances is the notification, and
 * what is left here is handing one moment to the browsers this process is holding open.
 */
export function liveThrough(db: Database, watching: Map<string, Set<(moment: Moment) => void>>) {
  return {
    say: async (happening: Happening) => announce(db, happening),

    watch: (conversationId: string, see: (moment: Moment) => void) => {
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

/** Hands one moment to the browsers this instance is holding open. */
export function handTo(
  watching: Map<string, Set<(moment: Moment) => void>>,
  happening: Happening,
): void {
  for (const see of watching.get(happening.conversationId) ?? []) see(happening.moment)
}
