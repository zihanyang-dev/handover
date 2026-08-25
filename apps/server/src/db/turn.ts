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
 */

import { sql } from 'kysely'
import type { Database, Tx } from './connection.ts'

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
