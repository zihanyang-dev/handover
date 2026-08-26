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

import { sql, type Expression } from 'kysely'
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
 * A question is unanswered when nobody has taken it — which the ledger answers on its own, and
 * nothing else does. Only the last question in a conversation is ever a candidate: saying
 * something is interrupting whatever came before it, so an older question is one somebody has
 * moved on from.
 *
 * Nothing about what was said after it comes into it, and that matters: interrupting writes the
 * new question down while the turn it interrupted is still ending, so the ending lands after the
 * question it has nothing to do with. Read that way round, the machine would never be given the
 * very question the person stopped it to ask.
 *
 * Asked one conversation at a time, which is what keeps it cheap: the machine's conversations are
 * looked up by machine, and each one's last question is a single index seek. Written as one join
 * across the two tables instead, Postgres reads every message and every turn on the deployment
 * and throws away the ones belonging to other machines — measured at 198,000 rows and 2,622
 * buffers to answer one check-in, against 349 buffers this way, and the difference grows with
 * everything anybody has ever said anywhere.
 */
export async function takeOne(db: Database, machineId: string): Promise<Taken | undefined> {
  const taken = await sql<Taken>`
    with waiting as (
      select c.id as conversation_id, c.agent_kind, c.agent_session_id,
             last.seq, last.content, last.created_at
        from conversations c
        cross join lateral (
          select m.seq, m.content, m.created_at
            from messages m
           where m.conversation_id = c.id and m.role = 'user'
           order by m.seq desc
           limit 1
        ) last
       where c.machine_id = ${machineId}
         and not exists (
           select 1 from turns t
            where t.conversation_id = c.id and t.asked_seq = last.seq
         )
       order by last.created_at
       limit 1
    ),
    claimed as (
      insert into turns (conversation_id, asked_seq, machine_id)
      select conversation_id, seq, ${machineId} from waiting
      on conflict do nothing
      returning conversation_id, asked_seq
    )
    select w.conversation_id  as "conversationId",
           w.agent_kind       as "agentKind",
           w.agent_session_id as "agentSession",
           w.seq              as "askedSeq",
           w.content          as asked
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

/**
 * Whether a conversation is still owed an answer.
 *
 * Its last question, and only that one. Saying something is interrupting whatever came before it,
 * so an older question is one somebody has moved on from — the same rule {@link takeOne} hands
 * work out by, written once here so that what is handed out and what is shown as working cannot
 * come apart.
 *
 * A fragment rather than a query, because it is asked in two shapes: on its own about one
 * conversation, and as a column beside every conversation in a Space. Written twice, the list and
 * the page would each be answering a slightly different question about the same thing.
 *
 * Read one conversation at a time. Expressed as a join over the two tables it comes out as a hash
 * join across every message and every turn on the deployment, whatever the conversation asking:
 * measured at 611 buffers against 10, on a Space page that every open browser asks for.
 */
export function stillOwed(conversationId: Expression<string>) {
  return sql<boolean>`coalesce((
    select not exists (
      select 1 from turns t
       where t.conversation_id = m.conversation_id
         and t.asked_seq = m.seq
         and t.ended_at is not null
    )
      from messages m
     where m.conversation_id = ${conversationId} and m.role = 'user'
     order by m.seq desc
     limit 1
  ), false)`
}

/** Whether this one conversation is still owed an answer. */
export async function owedAnAnswer(db: Database | Tx, conversationId: string): Promise<boolean> {
  const asked = await db
    .selectNoFrom(stillOwed(sql.val(conversationId)).as('owed'))
    .executeTakeFirstOrThrow()

  return asked.owed
}

/**
 * Every turn this machine left open, with the question each was answering.
 *
 * Also the answer to "is this machine busy", which is the ledger's to give rather than the
 * machine's: asked of the machine, the answer is stale the moment it finishes a turn.
 */
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
 * Which turn somebody asked this machine to stop.
 *
 * The turn and not just the conversation, because a stop can be about a turn that has already
 * ended by the time it is read out: somebody interrupts, the turn they stopped ends, the machine
 * takes the question they interrupted with, and a stop computed a moment earlier arrives about a
 * turn that no longer exists. Named by conversation alone it stops the wrong one — measured, and
 * it left that turn claimed with nobody running it.
 */
export type Stopping = {
  readonly conversationId: string
  readonly askedSeq: number
}

/**
 * The turn on this machine that somebody has asked it to stop, if there is one.
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
export async function stopWantedOn(db: Database, machineId: string): Promise<Stopping | undefined> {
  const wanted = await db
    .selectFrom('turns')
    .select(['turns.conversation_id as conversationId', 'turns.asked_seq as askedSeq'])
    .where('turns.machine_id', '=', machineId)
    .where('turns.ended_at', 'is', null)
    // Asked of the turn rather than joined from the messages, which decides which table is read
    // first: there is at most one turn running on a machine, and there is no bound at all on how
    // many things have been said to it. Joined the other way this read every activity ever
    // written on this deployment to find the one that mattered.
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('messages')
          .select('messages.seq')
          .whereRef('messages.conversation_id', '=', 'turns.conversation_id')
          .whereRef('messages.seq', '>', 'turns.asked_seq')
          .where('messages.role', '=', 'activity')
          .where(sql<boolean>`messages.content ->> 'activityType' = ${ACTIVITY.stopAsked}`),
      ),
    )
    .limit(1)
    .executeTakeFirst()

  return wanted
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
      // The conversation is held before anything is written into it, because that is the lock
      // `append` counts on to decide what number the next message gets. Every other writer takes
      // it; one that did not would be the one place two messages could be handed the same place
      // in the same transcript.
      await tx
        .selectFrom('conversations')
        .select('id')
        .where('id', '=', turn.conversationId)
        .forUpdate()
        .executeTakeFirst()

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
