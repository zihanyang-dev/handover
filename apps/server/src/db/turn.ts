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
import { SILENT_FOR_SECONDS } from '../machine/presence.ts'
import type { Database, Tx } from './connection.ts'
import { append } from './message.ts'
import { STATE } from './task.ts'

/** A question waiting to be answered, as the machine that just took it is told. */
export type Taken = {
  readonly conversationId: string
  readonly agentKind: string
  /** What the agent calls this conversation, when it has said so. Absent on a first turn. */
  readonly agentSession: string | null
  /** Where this turn starts, so the machine can name what it writes after it. */
  readonly afterSeq: number
  /**
   * What it is for, when somebody handed this conversation over. Null when nobody has.
   *
   * A turn on a conversation somebody is sitting in front of answers a question. A turn on one
   * somebody walked away from answers nothing — it carries on, and what it carries on towards is
   * this. Sent on every turn rather than once, because the agent's own memory of the last turn
   * may not have survived (`03` decision ⑨) and a turn that forgot everything still has to know
   * what it is doing.
   */
  readonly goal: string | null
  /** What a person said, when the line this turn begins after is one. Null when it is not. */
  readonly asked: unknown
}

/**
 * Takes the longest-waiting turn on this machine, if there is one nobody has taken.
 *
 * The read and the claim are one statement. Split into two, both instances read the same
 * unclaimed turn before either writes, and the check protects nothing — which is the whole
 * failure this table exists to make impossible.
 */
/** Somebody is sitting in front of it: their last question, if nobody took it. */
function beingAsked(machineId: string) {
  return sql`
    asked as (
      -- Somebody is sitting in front of it: their last question, if nobody took it.
      select c.id as conversation_id, c.agent_kind, c.agent_session_id,
             last.seq, last.content, last.created_at, 'user'::text as role, null::text as goal
        from conversations c
        cross join lateral (
          select m.seq, m.content, m.created_at
            from messages m
           where m.conversation_id = c.id and m.role = 'user'
           order by m.seq desc
           limit 1
        ) last
       where c.machine_id = ${machineId}
         and not exists (select 1 from tasks k
                          where k.conversation_id = c.id and k.ended_at is null)
    )`
}

/**
 * Somebody handed it over: the last line of it, whatever that line is.
 *
 * It is not answering anything — it is carrying on — so the turn begins after whatever came last.
 */
function carryingOn(machineId: string) {
  return sql`    carrying_on as (
      -- Somebody handed it over: the last line of it, whatever that line is. It is not answering
      -- anything — it is carrying on — so the turn begins after whatever came last.
      select c.id as conversation_id, c.agent_kind, c.agent_session_id,
             last.seq, last.content, last.created_at, last.role, k.goal
        from conversations c
        join tasks k on k.conversation_id = c.id and k.ended_at is null
        cross join lateral (
          select m.seq, m.content, m.created_at, m.role
            from messages m
           where m.conversation_id = c.id
           order by m.seq desc
           limit 1
        ) last
       where c.machine_id = ${machineId}
         and k.state = ${STATE.working}
         -- Waiting on what it handed off is not a state of its own: it is whether its children
         -- have ended, which is one index seek and cannot go stale.
         --
         -- Two exceptions, and they are the same reason: a child that will not move again on its
         -- own is not something to wait for, it is something the parent has to be told about.
         --
         -- One is waiting on *it*. A child's owner is the one that handed it out, so a child that
         -- is waiting is asking this very piece of work a question, and counting that as a reason
         -- not to run it is the two of them waiting for each other for ever.
         --
         -- The other has no machine left. Silence past the threshold is what "gone" means
         -- everywhere here; a parent held by a machine that never comes back is held for ever.
         -- Being let go is only half of it — being told is the other half, and that is the
         -- waker's. Either half alone leaves the two of them waiting on each other.
         and not exists (select 1 from tasks kid
                          join conversations kc on kc.id = kid.conversation_id
                          join machines km on km.id = kc.machine_id
                          where kid.parent_id = k.id
                            and kid.ended_at is null
                            and kid.state <> ${STATE.wait}
                            and km.last_seen_at > now() - ${SILENT_FOR_SECONDS} * interval '1 second')
    )`
}

/**
 * The conversations on this machine that are owed a turn, longest-waiting first.
 *
 * **Two kinds of conversation, owed a turn for different reasons.** One somebody is sitting in
 * front of is owed one when they have asked something nobody took. One somebody handed over is
 * owed one whenever the last line in it has not been picked up — it moves without being spoken
 * to, and whether it should is `tasks.state`, never anything read out of the transcript.
 *
 * Both halves take **the last line and only the last line**, and that matters: interrupting
 * writes the new question down while the turn it interrupted is still ending, so the ending lands
 * after the question it has nothing to do with. Older lines are ones somebody has moved on from.
 *
 * Written as one lateral with a condition in it, the plain half loses its index — the planner
 * cannot know per row which rule applies. Two halves, each a single index seek per conversation:
 * one on the questions, one on the transcript. Written the other way round — one join across the
 * two tables — Postgres reads every message and every turn on the deployment and throws away the
 * ones belonging to other machines, measured at 198,000 rows and 2,622 buffers to answer one
 * check-in against 349 this way.
 */
function owedATurn(machineId: string) {
  return sql`
    ${beingAsked(machineId)},
    ${carryingOn(machineId)},
    waiting as (
      select * from (select * from asked union all select * from carrying_on) owed
       -- Not "a turn keyed to this line" but "any turn since it". A turn no longer has to be
       -- keyed to a question, so a conversation somebody handed over and then took back has
       -- turns sitting after the last thing the person said — and asking the narrow question
       -- would hand that person's opening line out all over again, years later.
       where not exists (
           select 1 from turns t
            where t.conversation_id = owed.conversation_id and t.after_seq >= owed.seq
         )
         -- One at a time, and said here because it is the ledger's to say. prd.md 04 ⑫ is that
         -- a machine does exactly one thing at once — two agents in one directory tread on each
         -- other's files — and it is also the only limit on how much runs at once anywhere.
         --
         -- A machine that is handed a second question ignores it, so the row would sit claimed by
         -- somebody who will never run it, and that conversation would read as working until the
         -- machine restarted. Asked at the door instead of here, every other caller has to
         -- remember; asked here, none of them can get it wrong.
         and not exists (
           select 1 from turns busy
            where busy.machine_id = ${machineId} and busy.ended_at is null
         )
       order by created_at
       limit 1
    )`
}

export async function takeOne(db: Database, machineId: string): Promise<Taken | undefined> {
  // Written by hand because the correctness *is* the SQL: claiming and reading back what was
  // claimed happen in one statement, against one snapshot. Two statements would hand the same
  // turn to two machines, and the builder version would still have to be read as this to see it.
  const taken = await sql<Taken>`
    with ${owedATurn(machineId)},
    claimed as (
      insert into turns (conversation_id, after_seq, machine_id)
      select conversation_id, seq, ${machineId} from waiting
      on conflict do nothing
      returning conversation_id, after_seq
    )
    select w.conversation_id  as "conversationId",
           w.agent_kind       as "agentKind",
           w.agent_session_id as "agentSession",
           w.seq              as "afterSeq",
           w.goal             as goal,
           -- Only when the line this turn begins after is a person's. On a conversation somebody
           -- handed over that line is usually the ending of the turn before, and an ending is not
           -- something anybody said.
           case when w.role = 'user' then w.content end as asked
      from claimed c
      join waiting w on w.conversation_id = c.conversation_id and w.seq = c.after_seq
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
export async function endTurn(tx: Tx, conversationId: string, afterSeq: number): Promise<void> {
  await tx
    .updateTable('turns')
    .set({ ended_at: sql<Date>`clock_timestamp()` })
    .where('conversation_id', '=', conversationId)
    .where('after_seq', '=', afterSeq)
    .where('ended_at', 'is', null)
    .execute()
}

/** Which question a turn on this conversation is still running, if one is. */
export async function openTurn(tx: Tx, conversationId: string): Promise<number | undefined> {
  const open = await tx
    .selectFrom('turns')
    .select('after_seq as afterSeq')
    .where('conversation_id', '=', conversationId)
    .where('ended_at', 'is', null)
    .executeTakeFirst()

  return open?.afterSeq
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
         and t.after_seq = m.seq
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
): Promise<readonly { conversationId: string; afterSeq: number }[]> {
  return db
    .selectFrom('turns')
    .select(['conversation_id as conversationId', 'after_seq as afterSeq'])
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
  readonly afterSeq: number
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
    .select(['turns.conversation_id as conversationId', 'turns.after_seq as afterSeq'])
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
          .whereRef('messages.seq', '>', 'turns.after_seq')
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
        key: `${String(turn.afterSeq)}/end`,
        message: { role: 'activity', content: { activityType: ACTIVITY.unknown } },
      })
      await endTurn(tx, turn.conversationId, turn.afterSeq)
    }

    return stranded.length
  })
}
