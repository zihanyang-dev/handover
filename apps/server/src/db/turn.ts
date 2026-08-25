/**
 * What is being run, as opposed to what was said.
 *
 * The transcript is the record of a conversation; this is the record of its work. They answer
 * different questions and neither can answer the other's: "did anybody start this" is not
 * something the words can say, and "what did it tell me" is not something a claim can.
 *
 * Every fact here is decided by the database. Taking a turn is an insert against a primary key, so
 * two machines racing both run it and one of them loses; ending one is a conditional update, so a
 * turn ends once. Nothing is inferred, and nothing is decided in TypeScript.
 *
 * `forgetStranded` is the one path here that writes into the transcript as well, and it must: the
 * ledger saying a turn is over while the transcript still reads as running would be a conversation
 * that looks alive to anybody who scrolls it. Both halves go in one transaction.
 */

import { sql } from 'kysely'
import { ACTIVITY } from '../conversation/transcript.ts'
import type { Database, Tx } from './connection.ts'
import { append } from './message.ts'

/** A question waiting to be answered, as the machine that just took it is told. */
export type Taken = {
  readonly conversationId: string
  readonly agentKind: string
  /** What the agent calls this conversation, when it has said so. Absent on a first turn. */
  readonly agentSession: string | null
  /** Where the question sits, so the machine can name what it writes after it. */
  readonly askedSeq: number
  readonly asked: unknown
}

/**
 * Takes the longest-waiting question on this machine, if there is one nobody has taken.
 *
 * The read and the claim are one statement. Split into two, both instances read the same
 * unclaimed question before either writes, and the check protects nothing — which is the whole
 * failure this table exists to make impossible.
 *
 * A question is unanswered when nothing has been said after it. A request to stop does not count:
 * it is not an answer, and counting it would hide the question from the only machine that could
 * ever end the turn.
 */
export async function takeOne(db: Database, machineId: string): Promise<Taken | undefined> {
  const taken = await sql<Taken>`
    with waiting as (
      select m.conversation_id, m.seq, m.content, c.agent_kind, c.agent_session_id
        from messages m
        join conversations c on c.id = m.conversation_id
       where c.machine_id = ${machineId}
         and m.role = 'user'
         and not exists (
           select 1 from messages later
            where later.conversation_id = m.conversation_id
              and later.seq > m.seq
              and not (later.role = 'activity' and later.content ->> 'activityType' = 'stop')
         )
         and not exists (
           select 1 from turns t
            where t.conversation_id = m.conversation_id and t.asked_seq = m.seq
         )
       order by m.created_at
       limit 1
    ),
    claimed as (
      insert into turns (conversation_id, asked_seq, machine_id)
      select conversation_id, seq, ${machineId} from waiting
      on conflict do nothing
      returning conversation_id, asked_seq
    )
    select w.conversation_id as "conversationId",
           w.agent_kind      as "agentKind",
           w.agent_session_id as "agentSession",
           w.seq             as "askedSeq",
           w.content         as asked
      from claimed c
      join waiting w on w.conversation_id = c.conversation_id and w.seq = c.asked_seq
  `.execute(db)

  return taken.rows[0]
}

/**
 * Says this turn is over.
 *
 * Conditional on it still being open, so the second caller changes nothing: a machine that reports
 * an ending twice, or one that reports one while another process is closing the same turn on its
 * behalf, must not move the moment it ended.
 */
export async function endTurn(tx: Tx, conversationId: string, askedSeq: number): Promise<void> {
  await tx
    .updateTable('turns')
    .set({ ended_at: sql<Date>`clock_timestamp()` })
    .where('conversation_id', '=', conversationId)
    .where('asked_seq', '=', askedSeq)
    .where('ended_at', 'is', null)
    .execute()
}

/** Which question a turn on this conversation is still running, if one is. */
export async function openTurn(tx: Tx, conversationId: string): Promise<number | undefined> {
  const open = await tx
    .selectFrom('turns')
    .select('asked_seq as askedSeq')
    .where('conversation_id', '=', conversationId)
    .where('ended_at', 'is', null)
    .executeTakeFirst()

  return open?.askedSeq
}

/** Every turn this machine left open, with the question each was answering. */
export async function openTurnsOn(
  db: Database,
  machineId: string,
): Promise<readonly { conversationId: string; askedSeq: number }[]> {
  return db
    .selectFrom('turns')
    .select(['conversation_id as conversationId', 'asked_seq as askedSeq'])
    .where('machine_id', '=', machineId)
    .where('ended_at', 'is', null)
    .execute()
}

/**
 * The conversation on this machine that somebody has asked it to stop, if there is one.
 *
 * Answered by the ledger: a stop matters exactly while the turn it was asked about is still
 * running. Read from the transcript instead, every line the agent wrote after the request would
 * have to be examined to decide whether the request was still standing — and an agent goes on
 * writing for as long as it takes the request to reach it.
 *
 * Nothing has to clear it. The turn ending is the answer, and until there is one the machine is
 * told again on every report — which is also what makes a request that arrived while the machine
 * was between reports arrive on the next one instead of being lost.
 */
export async function stopWantedOn(db: Database, machineId: string): Promise<string | undefined> {
  const wanted = await db
    .selectFrom('turns')
    .innerJoin('messages', (join) =>
      join
        .onRef('messages.conversation_id', '=', 'turns.conversation_id')
        .on('messages.role', '=', 'activity'),
    )
    .select('turns.conversation_id as conversationId')
    .where('turns.machine_id', '=', machineId)
    .where('turns.ended_at', 'is', null)
    .whereRef('messages.seq', '>', 'turns.asked_seq')
    .where(sql<boolean>`messages.content ->> 'activityType' = ${ACTIVITY.stopAsked}`)
    .limit(1)
    .executeTakeFirst()

  return wanted?.conversationId
}

/**
 * Closes every turn this machine left open, saying nobody knows how they went.
 *
 * Called when a machine says it has just started, which is the one moment when an open turn on it
 * is certainly nobody's: killing the process that drives an agent does not kill the agent, so a
 * turn abandoned that way went on without anybody watching, and what it did is unknowable here.
 *
 * `unknown` and not `failed`, because the two ask different things of a person: a failed turn is
 * safe to ask for again, and this one may already have done everything it was asked.
 *
 * Both halves in one transaction: the ledger says the turn is over and the transcript says how it
 * looked. A ledger closed without the record would leave a conversation that reads as still
 * running to anybody who scrolls it.
 */
export async function forgetStranded(db: Database, machineId: string): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const stranded = await openTurnsOn(tx, machineId)

    for (const turn of stranded) {
      await append(tx, {
        conversationId: turn.conversationId,
        key: `${String(turn.askedSeq)}/end`,
        message: { role: 'activity', content: { activityType: ACTIVITY.unknown } },
      })
      await endTurn(tx, turn.conversationId, turn.askedSeq)
    }

    return stranded.length
  })
}
