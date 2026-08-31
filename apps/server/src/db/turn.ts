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
import { atOnceFor } from './machine.ts'
import { append } from './message.ts'
import { STATE, waitsForAPerson } from './task.ts'

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
  /**
   * A directory a person pointed this conversation at, when they pointed it at one.
   *
   * Null nearly always, and then the machine works somewhere of its own — a folder named after
   * the conversation. It is the only path this deployment stores, and it is stored because
   * somebody typed it; where work happens otherwise is the machine's own business, which is what
   * leaves room for a sandbox to answer it differently.
   */
  readonly worksIn: string | null
  /**
   * The conversation this one was opened for, when an agent opened it as a sub-task.
   *
   * Null on everything else. The machine turns it into a place: a sub-task works inside a folder
   * under the one its parent is working in, so it reads what that work has been writing simply by
   * being underneath it, and writes where nothing else does.
   */
  readonly subtaskOf: string | null
  /**
   * Whether anything has been run in this conversation before this turn.
   *
   * The machine tells two folders apart with it: one it makes for the first time, and one it has
   * to make again because somebody deleted what was there. Only the second is worth saying.
   */
  readonly hasRunBefore: boolean
  /**
   * Everything a person said since the turn before this one, oldest first.
   *
   * A list rather than one line, because two people can each say something before either is
   * answered and both have to reach the agent. Empty on a turn nobody asked for — a conversation
   * somebody handed over runs turns whose last line is the ending of the one before.
   *
   * `who` is a name and not an id: the machine has no table of people, and what it does with
   * these is put them in front of an agent. Null on lines written before a line said who wrote it.
   */
  readonly asked: readonly { readonly text: string; readonly who: string | null }[]
  /** Which model to run, when the last person to speak chose one. */
  readonly model: string | null
  /** How hard to think, when the last person to speak chose. */
  readonly effort: string | null
}

/**
 * Takes the longest-waiting turn on this machine, if there is one nobody has taken and its agent
 * has room for it.
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
      select c.id as conversation_id, c.agent_kind, c.agent_session_id, c.works_in,
             last.seq, last.content, last.created_at, 'user'::text as role, null::text as goal,
             ${whatItWasOpenedFor()} as subtask_of, ${hasRunBefore()} as ran_before
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
      select c.id as conversation_id, c.agent_kind, c.agent_session_id, c.works_in,
             last.seq, last.content, last.created_at, last.role, k.goal,
             ${whatItWasOpenedFor()} as subtask_of, ${hasRunBefore()} as ran_before
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
 * The conversation this one was opened for, when an agent opened it as a sub-task.
 *
 * A fact about the conversation and not about whichever piece of work is open in it right now.
 * That distinction is the whole reason this is not `k.parent_id`: a sub-task is owed turns as
 * work while its own piece of work is open, and as an ordinary conversation once that ends and
 * somebody types into it — two halves of {@link owedATurn}, one conversation, and the folder it
 * has been working in the whole time is one folder. Read off the open task, the second kind lands
 * somewhere else, the agent opens an empty directory, and everything it did is apparently gone.
 *
 * At most one row can match: a hand-off opens the conversation and its piece of work together, so
 * nothing else ever carries a parent. Ordered anyway, so that stops being something to know.
 */
function whatItWasOpenedFor() {
  return sql`(select up.conversation_id
                from tasks mine
                join tasks up on up.id = mine.parent_id
               where mine.conversation_id = c.id
               order by mine.created_at
               limit 1)`
}

/**
 * Whether anything has been run in this conversation before the turn being handed out.
 *
 * The machine needs it to tell two folders apart that look identical: one it is making for the
 * first time, and one it is making again because somebody deleted what was there. Only the second
 * is worth a line in the transcript.
 *
 * Asked of the ledger rather than guessed from the agent's session id, which was the first
 * attempt at it. A session is recorded only once an adapter emits one; a first turn that failed
 * before saying anything leaves it null, and the folder it worked in still existed. The fact
 * wanted here is that a turn happened, and that is what this asks.
 *
 * Evaluated with the rest of the look, before this turn is claimed, so it is never about itself.
 */
function hasRunBefore() {
  return sql`exists (select 1 from turns ran where ran.conversation_id = c.id)`
}

/**
 * The conversations on this machine that are owed a turn, longest-waiting first.
 *
 * **Two kinds of conversation, owed a turn for different reasons.** One somebody is sitting in
 * front of is owed one when they have asked something nobody took. One somebody handed over is
 * owed one whenever the last line in it has not been picked up — it moves without being spoken
 * to, and whether it should is `tasks.state`, never anything read out of the transcript.
 *
 * Both halves take **the last line** to decide *whether* a turn is owed and where it begins.
 * What that turn is asked is a separate question, answered in {@link takeOne}: everything a person
 * said since the turn before, because two people can each say something before either is
 * answered and losing one of them is losing a message.
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
         -- How many at once, and said here because it is the ledger's to say. Asked at the door
         -- instead, every other caller would have to remember; asked here, none of them can get
         -- it wrong.
         --
         -- Per agent and not per machine. A laptop with two agents on it is two answers to "how
         -- much is too much", and one number covering both is neither of them — it would also
         -- mean that starting something on Codex stopped Claude Code taking anything.
         --
         -- Counted rather than kept: a column would drift the first time a turn ended without
         -- anything decrementing it, and the agent would read as full for ever.
         --
         -- Safe to count only because the caller holds this machine's advisory lock. Under read
         -- committed two instances would each count against their own snapshot, neither seeing
         -- the other's uncommitted insert, and both would claim — which is exactly what
         -- turns_one_open_per_machine was standing in for before there was a number here.
         and (
           select count(*) from turns busy
             join conversations bc on bc.id = busy.conversation_id
            where busy.machine_id = ${machineId}
              and busy.ended_at is null
              and bc.agent_kind = owed.agent_kind
         ) < ${atOnceFor(sql.val(machineId), sql.ref('owed.agent_kind'))}
         -- The machine is still here, asked in the statement that claims rather than at the door.
         -- The door read the credential in an earlier transaction; somebody can take the machine
         -- out between that and this, and then this hands one more turn to a laptop nobody can
         -- reach — with its credential already refused everywhere else. Same shape as the check
         -- stillItsToWriteOn makes for a machine that writes.
         and exists (
           select 1 from machines here
            where here.id = ${machineId} and here.removed_at is null
         )
       order by created_at
       limit 1
    )`
}

/**
 * Everything a person said since the turn before this one, oldest first, each with the name of
 * whoever said it.
 *
 * Not "the last line", which is what this took while a Space held one person. A second person
 * turns that into losing a message: two people each ask something before either is answered, only
 * the later one is ever sent, and the earlier one sits in the transcript looking queued for ever.
 * A bot in a Slack thread gets both.
 *
 * The lower bound is what taking one line used to do. Interrupting writes the new question down
 * while the turn it interrupted is still ending, and that turn's after_seq sits between the two —
 * so a question somebody has moved on from is already below the bound.
 */
function everythingSaidSince() {
  return sql`left join lateral (
        select json_agg(
                 json_build_object('text', m.content ->> 'text', 'who', u.display_name)
                 order by m.seq
               ) as lines
          from messages m
          left join users u on u.id = m.said_by
         where m.conversation_id = c.conversation_id
           and m.role = 'user'
           and m.seq <= c.after_seq
           and m.seq > coalesce(
                 (select max(before.after_seq) from turns before
                   where before.conversation_id = c.conversation_id
                     and before.after_seq < c.after_seq),
                 0)
      ) said on true`
}

export async function takeOne(db: Database, machineId: string): Promise<Taken | undefined> {
  return db.transaction().execute(async (tx) => takingOne(tx, machineId))
}

async function takingOne(tx: Tx, machineId: string): Promise<Taken | undefined> {
  // How many an agent is already running is a count, and a count under read committed is a lie
  // the moment a second instance is counting too: each sees its own snapshot, neither sees the
  // other's uncommitted claim, and a machine allowed three ends up with six. A unique index said
  // this for a limit of one; no index says "at most n". So the counting and the claiming are put
  // behind one lock, and it is this machine's, because a turn on it can only be claimed here.
  //
  // Contention is nil in practice: what queues behind it is another instance answering the same
  // machine's poll, and a machine polls once at a time.
  await sql`select pg_advisory_xact_lock(hashtextextended(${machineId}, 0))`.execute(tx)

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
           w.works_in         as "worksIn",
           w.subtask_of       as "subtaskOf",
           w.ran_before       as "hasRunBefore",
           coalesce(said.lines, '[]'::json) as asked,
           -- A turn runs one model, so these belong to the turn and not to each line. Taken from
           -- the last thing said: two people who chose differently is not a conflict to resolve,
           -- it is the later choice, the same rule that decides where the turn begins.
           case when w.role = 'user' then w.content ->> 'model' end as model,
           case when w.role = 'user' then w.content ->> 'effort' end as effort
      from claimed c
      join waiting w on w.conversation_id = c.conversation_id and w.seq = c.after_seq
      ${everythingSaidSince()}
  `.execute(tx)

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
async function openTurnsOn(
  db: Database,
  machineId: string,
): Promise<readonly { conversationId: string; afterSeq: number }[]> {
  return (
    db
      .selectFrom('turns')
      .select(['conversation_id as conversationId', 'after_seq as afterSeq'])
      .where('machine_id', '=', machineId)
      .where('ended_at', 'is', null)
      // By conversation, because {@link forgetStranded} locks each of these rows in the order they
      // arrive in. Unordered, Postgres may hand them back differently on two executions — and two
      // is what happens when a machine's restart report times out and is sent again. Both
      // transactions then take the same conversations in different orders, which is a deadlock, and
      // Postgres answers it by killing one: a restart that reports a fault for no reason a person
      // can see. `rules/locks.spec.ts` is what keeps the next loop of this shape ordered.
      .orderBy('conversation_id')
      .execute()
  )
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
export type StopWanted = {
  readonly conversationId: string
  readonly afterSeq: number
}

/**
 * Every turn on this machine that somebody has asked it to stop.
 *
 * All of them, because a machine runs several. Told about one, it would have no way to say which
 * of its turns the answer was about — and a stop asked of the second would wait out the first.
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
export async function stopsWantedOn(
  db: Database,
  machineId: string,
): Promise<readonly StopWanted[]> {
  return (
    db
      .selectFrom('turns')
      .select(['turns.conversation_id as conversationId', 'turns.after_seq as afterSeq'])
      .where('turns.machine_id', '=', machineId)
      .where('turns.ended_at', 'is', null)
      // Asked of the turn rather than joined from the messages, which decides which table is read
      // first: a machine runs a handful of turns at once, and there is no bound at all on how many
      // things have been said to it. Joined the other way this read every activity ever written on
      // this deployment to find the ones that mattered.
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
      .execute()
  )
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
      // And the piece of work stops, exactly as it does when a machine reports a turn that went
      // wrong. Without this the task stays `working`, the very next look hands it another turn,
      // and an agent quietly does again whatever the abandoned turn may already have done — which
      // is the one thing `unknown` exists to prevent.
      await waitsForAPerson(tx, turn.conversationId)
    }

    return stranded.length
  })
}
