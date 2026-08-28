/**
 * How a browser watching a turn gets told, across every instance.
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

import { textPieces, utf8Length } from '@handover/universal'
import { sql } from 'kysely'
import { Happening, type Live } from '../conversation/live.ts'
import type { Watchers } from '../conversation/watchers.ts'
import type { Env } from '../env.ts'
import type { Log } from '../log.ts'
import type { Database, Tx } from './connection.ts'
import { stillItsToWriteOn } from './machine.ts'
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
  if (utf8Length(JSON.stringify(happening)) <= ROOM) return happening
  if (happening.watched.seen !== 'moment') return happening

  const moment = happening.watched.moment
  if (moment.said === 'output') return happening

  const words = moment.said === 'thinking' ? moment.text : moment.arg
  const firstPiece = textPieces(words)[0]?.text ?? ''
  const shorter = `${firstPiece}…`
  const cut =
    moment.said === 'thinking' ? { ...moment, text: shorter } : { ...moment, arg: shorter }

  return { conversationId: happening.conversationId, watched: { seen: 'moment', moment: cut } }
}

/** Says one thing to every instance, including this one. */
async function announce(db: Database | Tx, happening: Happening): Promise<void> {
  const payload = JSON.stringify(shortened(happening))
  if (utf8Length(payload) > ROOM) throw new Error('live notification exceeds the PostgreSQL limit')

  await sql`select pg_notify(${CHANNEL}, ${payload})`.execute(db)
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

/** Authorizes a machine and publishes its live moment under the same row lock. */
export async function sayLiveFromMachine(
  db: Database,
  report: {
    readonly conversationId: string
    readonly machineId: string
    readonly watched: Happening['watched']
  },
): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    const conversation = await stillItsToWriteOn(tx, {
      conversationId: report.conversationId,
      machineId: report.machineId,
    })
    if (conversation === undefined) return false

    await announce(tx, { conversationId: report.conversationId, watched: report.watched })
    return true
  })
}

/**
 * Hears every moment happening on the other instances.
 *
 * Something this build cannot read is something nobody can act on, and it is gone either way —
 * said in the log once rather than thrown at whoever is watching.
 *
 * No `again`: a moment is worth nothing a second later and is kept nowhere, so there is nothing
 * to go and look at. What was missed while this was down is missed, and the page that was
 * watching reads the transcript on its own anyway.
 */
export function listenForLive(
  env: Env,
  log: Log,
  heard: (happening: Happening) => void,
): Listening {
  return listenOn({
    env,
    log,
    channel: CHANNEL,
    heard: (payload) => {
      const read = Happening.safeParse(JSON.parse(payload === '' ? 'null' : payload))
      if (read.success) heard(read.data)
      else log.warn('something live arrived in a shape this build does not know')
    },
  })
}

/**
 * Saying and watching, as one thing, which is what a route is handed.
 *
 * The two halves are not alike: saying is a statement in a transaction, and watching is a map
 * this process holds — see `conversation/watchers.ts`. They are put together here because a
 * route should not have to know that.
 */
export function liveThrough(db: Database, here: Watchers): Live {
  return {
    say: async (happening: Happening) => announce(db, happening),
    watch: here.watch,
  }
}
