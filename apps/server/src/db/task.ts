/**
 * A piece of work somebody handed over and walked away from.
 *
 * One row per hand-over rather than one per conversation: a conversation can be handed over,
 * finished, chatted in some more and handed over again, and those are two pieces of work — two
 * beginnings, two endings, and the second one remembers how the first went.
 *
 * `state` is the only thing here that nothing else could say. It is the agent's own declaration
 * that it stopped, and why. Everything else a person sees — that its machine is not here, that it
 * is waiting on what it handed off — is derived, for the same reason a conversation's three states
 * are: a machine that is killed never writes that it stopped.
 *
 * **Nothing here reads the transcript to decide what state a piece of work is in.** The transcript
 * is the open half of this system, where a new kind of activity is a value rather than a release;
 * deciding on it would mean the next activity anybody adds silently wakes every waiting piece of
 * work, with nothing to say so.
 *
 * Two statements do read it, and neither is that. The Inbox reads the last thing an agent asked,
 * to show it. And the sweep for stranded work asks whether the line it is about to write is
 * already there — under a key it chose itself, not an activity type anybody else can add — which
 * is the same constraint that makes writing it twice a no-op, used to avoid doing the work twice
 * rather than to decide anything.
 */

import { sql } from 'kysely'
import { ACTIVITY } from '../conversation/transcript.ts'
import { SILENT_FOR_SECONDS, type Whereabouts } from '../machine/presence.ts'
import type { Database, Tx } from './connection.ts'
import { held } from './conversation.ts'
import { stillItsToWriteOn } from './machine.ts'
import { append, type Saying } from './message.ts'
import { wakeMachine } from './waking.ts'

/** What it is up to, as far as anything that decides is concerned. Four, and no fifth. */
export const STATE = {
  /** Nobody has to do anything for it to move: it should be running, or about to be. */
  working: 'working',
  /** It asked its owner something. Only they can start it again. */
  wait: 'wait',
  /** It is waiting out a moment. Only the clock can start it again. */
  sleep: 'sleep',
  /** Over. Nothing starts it again — a second hand-over is a second piece of work. */
  done: 'done',
} as const

type State = (typeof STATE)[keyof typeof STATE]

/** The piece of work running in one conversation, if there is one. */
export type Task = {
  readonly id: string
  readonly conversationId: string
  readonly parentId: string | null
  readonly ownerUserId: string
  readonly goal: string
  readonly state: State
  readonly sleepUntil: Date | null
  readonly createdAt: Date
}

/**
 * Puts the piece of work in this conversation back to working, and wakes its machine.
 *
 * One call rather than two, because they are one event: something arrived that the agent has to
 * see, and it is exactly the same something that means it is no longer waiting. Left as two, the
 * caller that remembers one and forgets the other leaves either a machine that never looks or a
 * piece of work that reads as waiting while it runs.
 *
 * Only ever the open one. Saying something into a conversation whose work is over is `03`'s saying
 * — it does not bring anything back to life.
 */
export async function backToWork(tx: Tx, conversationId: string, machineId: string): Promise<void> {
  await tx
    .updateTable('tasks')
    .set({ state: STATE.working, sleep_until: null })
    .where('conversation_id', '=', conversationId)
    .where('ended_at', 'is', null)
    .where('state', '!=', STATE.working)
    .execute()

  await wakeMachine(tx, machineId)
}

const TASK_COLUMNS = [
  'id',
  'conversation_id as conversationId',
  'parent_id as parentId',
  'owner_user_id as ownerUserId',
  'goal',
  'state',
  'sleep_until as sleepUntil',
  'created_at as createdAt',
] as const

/** The open piece of work in this conversation, held for the rest of the transaction. */
export async function openTaskOn(tx: Tx, conversationId: string): Promise<Task | undefined> {
  const found = await tx
    .selectFrom('tasks')
    .select(TASK_COLUMNS)
    .where('conversation_id', '=', conversationId)
    .where('ended_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()

  return found as Task | undefined
}

export type HandedOver =
  | { readonly kind: 'handed-over'; readonly taskId: string }
  /** Something is already running in this conversation. One at a time, and the index says so. */
  | { readonly kind: 'already-handed-over' }
  | { readonly kind: 'no-conversation' }

export type HandingOver = Saying & {
  readonly userId: string
  /** The agent's own restatement, which a person read before any of this started. */
  readonly goal: string
}

/**
 * Hands the conversation over: from here it moves without being spoken to.
 *
 * The goal is a column and not a pointer at a message, because it is the identity of the work —
 * a list shows it, an Inbox shows it, and somebody coming back in three days reads it first. It
 * is the agent's restatement rather than whatever the person typed: "fine, take it from here" is
 * not a goal, and the sentence that is one should come from whoever has to make it true.
 */
export async function handOver(db: Database, handing: HandingOver): Promise<HandedOver> {
  return db.transaction().execute(async (tx) => {
    const conversation = await held(tx, handing)
    if (conversation === undefined) return { kind: 'no-conversation' }
    if ((await openTaskOn(tx, conversation.id)) !== undefined) {
      return { kind: 'already-handed-over' }
    }

    const opened = await tx
      .insertInto('tasks')
      .values({
        conversation_id: conversation.id,
        owner_user_id: handing.userId,
        goal: handing.goal,
        state: STATE.working,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    await note(tx, handing.conversationId, handing.key, {
      activityType: ACTIVITY.handedOver,
      text: handing.goal,
    })
    await wakeMachine(tx, conversation.machineId)

    return { kind: 'handed-over', taskId: opened.id }
  })
}

/**
 * One activity, under a name that makes writing it twice write it once.
 *
 * Says whether this call is the one that wrote it. Most callers have nothing to do with the
 * answer — they are inside a transaction that only runs once anyway. The one that does is the
 * telling about a machine that has gone: every instance asks the same question every ten seconds,
 * and only the one that actually wrote the line should go on to wake anybody about it.
 */
async function note(
  tx: Tx,
  conversationId: string,
  key: string,
  content: { readonly activityType: string } & Record<string, unknown>,
): Promise<boolean> {
  const said = await append(tx, { conversationId, key, message: { role: 'activity', content } })

  return said.kind !== 'said-already'
}

/**
 * A turn went wrong, so this piece of work now needs a person.
 *
 * `prd.md` ⑧, and this is the whole of how it is enforced: a piece of work that is not `working`
 * is not handed a turn, so an agent whose turn failed does not get the chance to try again. It is
 * refused work rather than told not to — the rule has something executing it.
 *
 * Does nothing to a conversation nobody handed over, which is the ordinary case.
 */
export async function waitsForAPerson(tx: Tx, conversationId: string): Promise<void> {
  await tx
    .updateTable('tasks')
    .set({ state: STATE.wait })
    .where('conversation_id', '=', conversationId)
    .where('ended_at', 'is', null)
    .execute()
}

export type Stopped =
  | { readonly kind: 'taken-back'; readonly alsoStopped: number }
  /** Nothing was running. Taking back what already ended changes nothing. */
  | { readonly kind: 'nothing-to-take-back' }
  | { readonly kind: 'no-conversation' }

/**
 * A person takes it back, and everything it handed off comes back with it.
 *
 * Everything under it, because the alternative is an orphan: what it handed off is still changing
 * files on somebody's machine, and the piece of work that would have read the result is over.
 * Nobody is watching it and nobody wants it.
 *
 * Only a person cascades. A piece of work that says it cannot do something wakes whoever handed
 * it out and lets them decide — an agent does not get to end somebody else's work.
 */
export async function takeBack(db: Database, saying: Saying): Promise<Stopped> {
  return db.transaction().execute(async (tx) => {
    const conversation = await held(tx, saying)
    if (conversation === undefined) return { kind: 'no-conversation' }

    const root = await openTaskOn(tx, conversation.id)
    if (root === undefined) return { kind: 'nothing-to-take-back' }

    // Written by hand because the correctness *is* the SQL: this one and everything under it end
    // in the snapshot they were read in. Through the builder a reader would still have to rebuild
    // it to see that no child can be missed on the way.
    //
    // It walked the tree recursively while a tree could be any depth. `prd.md` 07 ⑤ stops it at
    // two — only what a person owns may hand work out — so "everything under this" is one index
    // seek on `parent_id`, and there is no shape of data a walk would have found and this misses.
    const stopped = await sql<{ id: string; conversationId: string; machineId: string }>`
      with over as (
        update tasks set state = ${STATE.done}, ended_at = now(), sleep_until = null
         where (id = ${root.id} or parent_id = ${root.id})
           and ended_at is null
        returning id, conversation_id
      )
      select o.id, o.conversation_id as "conversationId", c.machine_id as "machineId"
        from over o join conversations c on c.id = o.conversation_id
    `.execute(tx)

    // Two lines each, and they are not the same statement twice. The stop is how a turn that is
    // *running right now* is reached: `stopsWantedOn` finds one by looking for exactly this line
    // written after the turn began, so without it the machine would carry on to the end of a turn
    // whose piece of work is already over — and this is the promise the button makes, on every
    // conversation under it as well as the one somebody pressed. The second says what happened,
    // which is not "somebody pressed stop".
    //
    // Both named after the piece of work rather than after the request, so pressing twice while it
    // winds down writes each line once in each conversation of the subtree.
    for (const one of stopped.rows) {
      await note(tx, one.conversationId, `${saying.key}/${one.id}/stop`, {
        activityType: ACTIVITY.stopAsked,
      })
      await note(tx, one.conversationId, `${saying.key}/${one.id}`, {
        activityType: ACTIVITY.takenBack,
      })
      // Woken as well as told: a machine between reports would otherwise wait out its hold before
      // hearing either of the lines above.
      await wakeMachine(tx, one.machineId)
    }

    return { kind: 'taken-back', alsoStopped: stopped.rows.length - 1 }
  })
}

/** What a machine says about the piece of work it is running. Proved by its credential. */
export type Reporting = {
  readonly conversationId: string
  readonly machineId: string
  readonly key: string
}

export type Reported =
  | { readonly kind: 'noted' }
  /** The same thing again, or a conversation this machine is not running work in. */
  | { readonly kind: 'nothing-to-report' }

/**
 * Runs one thing a machine says about a conversation it was given.
 *
 * The machine is proved by its credential and matched against the conversation here, inside the
 * transaction that writes: the middleware's check happened before this opened, and a machine
 * somebody removed in between must not get one more line in.
 */
async function onItsOwn(
  db: Database,
  reporting: Reporting,
  change: (tx: Tx, conversationId: string) => Promise<Reported>,
): Promise<Reported> {
  return db.transaction().execute(async (tx) => {
    const conversation = await stillItsToWriteOn(tx, reporting)

    return conversation === undefined ? { kind: 'nothing-to-report' } : change(tx, conversation)
  })
}

/**
 * Runs one thing a machine reports about a piece of work it is running.
 *
 * The same three risks every time, so they are the same function: the machine has to own the
 * conversation, the work has to be open, and what is written goes in under a name that makes a
 * retry land once.
 */
async function reports(
  db: Database,
  reporting: Reporting,
  change: (tx: Tx, task: Task) => Promise<Reported>,
): Promise<Reported> {
  return onItsOwn(db, reporting, async (tx, conversationId) => {
    const task = await openTaskOn(tx, conversationId)

    return task === undefined ? { kind: 'nothing-to-report' } : change(tx, task)
  })
}

/** How a piece of work stops working, and why. Three, because `working` is nobody else to set. */
export type HowItStopped =
  /** It asked whoever handed this out. Only they start it again. */
  | { readonly state: 'wait'; readonly question: string }
  /** It is waiting out a moment. Only the clock starts it again. */
  | { readonly state: 'sleep'; readonly until: Date }
  /** Over, one way or the other. Nothing starts it again. */
  | { readonly state: 'done'; readonly ending: Ending; readonly said: string }

/** How a piece of work ended, in the words a person reads. */
type Ending = 'done' | 'cannot'

/**
 * The agent stops working, and says why.
 *
 * One rule for all three, because they are one rule: move it off `working`, write the moment
 * down, and tell whoever was waiting on it. Written as three functions it was three places to
 * remember the third step — and one of them forgot, which left a piece of work that had asked
 * its owner a question that owner was never told about. Both sides waiting for each other, for
 * ever, with nothing to say so.
 *
 * `working` is not among them on purpose: an agent can stop itself and can never start itself.
 * What starts it again is a person saying something, a piece of work it handed out coming back,
 * or the clock — and none of those is the agent.
 */
export async function stopsWorking(
  db: Database,
  reporting: Reporting,
  how: HowItStopped,
): Promise<Reported> {
  return reports(db, reporting, async (tx, task) => {
    // The name decides, and it decides *first*. A report that already landed must move nothing a
    // second time: between the two attempts a person can have answered, and replaying the
    // question would put the work back in their Inbox with the answer already given and nobody
    // holding it. The retry is told it was noted, because it was.
    const first = await note(tx, task.conversationId, reporting.key, said(how))
    if (!first) return { kind: 'noted' }

    await moveTo(tx, task, how.state, how.state === 'sleep' ? how.until : null)
    await tellWhoeverWasWaiting(tx, task, how)

    return { kind: 'noted' }
  })
}

/** The moment, for a person reading the conversation later. */
function said(how: HowItStopped): { readonly activityType: string } & Record<string, unknown> {
  if (how.state === 'wait') return { activityType: ACTIVITY.asked, text: how.question }
  if (how.state === 'sleep') {
    return { activityType: ACTIVITY.asleep, until: how.until.toISOString() }
  }

  return { activityType: ACTIVITY.finished, ending: how.ending, text: how.said }
}

/**
 * Tells whoever handed this out, when there is now something for them.
 *
 * The telling is only half of it: a piece of work is not handed a turn while anything it handed
 * out is still open, and a child asking a question is still open. So {@link takeOne} does not
 * count a child that is waiting — see there. Both halves, or the two of them wait for each other.
 *
 * A question and a result are both something to read; going to sleep is not — whoever is waiting
 * on this is waiting for it to be over, and it is not over. They are counting its open children
 * either way, so nothing has to be cleared.
 *
 * A person is told by their Inbox, which is a query and needs no telling. An agent is told by
 * being handed another turn, which is this.
 */
async function tellWhoeverWasWaiting(tx: Tx, task: Task, how: HowItStopped): Promise<void> {
  if (task.parentId === null || how.state === 'sleep') return

  const parent = await tx
    .selectFrom('tasks')
    .innerJoin('conversations', 'conversations.id', 'tasks.conversation_id')
    .select(['tasks.conversation_id as conversationId', 'conversations.machine_id as machineId'])
    .where('tasks.id', '=', task.parentId)
    .where('tasks.ended_at', 'is', null)
    .executeTakeFirst()

  // Gone means a person took the whole tree back while this one was still going. Nothing to tell.
  if (parent === undefined) return

  await note(tx, parent.conversationId, `back/${task.id}/${how.state}`, {
    activityType: ACTIVITY.handedBack,
    text: how.state === 'wait' ? how.question : how.said,
    goal: task.goal,
    ...(how.state === 'done' ? { ending: how.ending } : {}),
  })
  await backToWork(tx, parent.conversationId, parent.machineId)
}

/**
 * Moves one piece of work, and nothing else.
 *
 * `ended_at` and `sleep_until` are set from the state rather than by the caller, because the table
 * has a check constraint for each pairing and a caller that gets one wrong finds out at runtime.
 */
async function moveTo(tx: Tx, task: Task, state: State, until: Date | null): Promise<void> {
  await tx
    .updateTable('tasks')
    .set({
      state,
      sleep_until: state === STATE.sleep ? until : null,
      ended_at: state === STATE.done ? sql<Date>`clock_timestamp()` : null,
    })
    .where('id', '=', task.id)
    .where('ended_at', 'is', null)
    .execute()
}

/** Something it wrote on purpose. The title is its name, so writing it again revises it. */
export async function writesOutput(
  db: Database,
  reporting: Reporting,
  written: { readonly title: string; readonly body: string },
): Promise<Reported> {
  return reports(db, reporting, async (tx, task) => {
    await tx
      .insertInto('outputs')
      .values({ task_id: task.id, title: written.title, body: written.body })
      .onConflict((conflict) =>
        conflict
          .columns(['task_id', 'title'])
          .doUpdateSet({ body: written.body, updated_at: sql<Date>`clock_timestamp()` }),
      )
      .execute()

    return { kind: 'noted' }
  })
}

/**
 * Wakes everything whose moment has come.
 *
 * A moment needs no scheduler: what it is waiting for is the clock, and the clock arrives on its
 * own. The only thing that has to be told is the machine, which is holding a request open and
 * will otherwise sit there until that request times out.
 *
 * One statement, through the partial index, touching only the rows that are due. The state is
 * written rather than left to be worked out against `now()` on every read — so what the column
 * says is what is true, and nothing that reads it has to carry a clock.
 */
export async function wakeWhoseTimeHasCome(db: Database): Promise<number> {
  return db.transaction().execute(async (tx) => {
    // Written by hand because the correctness *is* the SQL: the update and the read of what it
    // touched are one statement, so nobody is woken about a row this did not actually move.
    const woken = await sql<{ machineId: string }>`
      with due as (
        update tasks set state = ${STATE.working}, sleep_until = null
         where state = ${STATE.sleep} and sleep_until <= now()
        returning conversation_id
      )
      select distinct c.machine_id as "machineId"
        from due join conversations c on c.id = due.conversation_id
    `.execute(tx)

    for (const one of woken.rows) await wakeMachine(tx, one.machineId)

    return woken.rows.length
  })
}

/**
 * Tells a piece of work that something it handed out has no machine left.
 *
 * The other half of the exception in {@link carryingOn}. Being let go is not being told: a parent
 * handed a turn with nothing said would be an agent that woke for no reason it can see, and one
 * told but still held would be an agent that reads the news and cannot act on it. Written apart
 * once, and the two of them waited on each other with nothing anywhere to say so.
 *
 * Said once per child, by a key. Every instance runs this and they all run the same statement;
 * the second one to arrive writes nothing, because the message is already there under that name.
 *
 * A machine that comes back later is not undone. Whether that changes anything is the parent's to
 * decide, and it has been told everything it needs to decide it — which is the same rule as every
 * other way a piece of work can stop.
 */
export async function tellWhoeverIsWaitingOnAGoneMachine(db: Database): Promise<number> {
  const gone = await db
    .selectFrom('tasks as kid')
    .innerJoin('conversations as kc', 'kc.id', 'kid.conversation_id')
    .innerJoin('machines as km', 'km.id', 'kc.machine_id')
    .innerJoin('tasks as parent', 'parent.id', 'kid.parent_id')
    .innerJoin('conversations as pc', 'pc.id', 'parent.conversation_id')
    .select([
      'kid.id as taskId',
      'kid.goal',
      'km.name as machineName',
      'pc.id as parentConversationId',
      'pc.machine_id as parentMachineId',
    ])
    .where('kid.ended_at', 'is', null)
    .where('kid.state', '=', STATE.working)
    .where('parent.ended_at', 'is', null)
    .where('km.last_seen_at', '<', sql<Date>`now() - ${SILENT_FOR_SECONDS} * interval '1 second'`)
    // Not the ones already told. Nothing about a stranded child changes when its parent is told
    // — it is still `working`, and its machine is still away — so without this the same rows come
    // back on every sweep for as long as they exist, and the sweep gets slower for ever. What was
    // said is already written down, under a name this statement can ask for: `messages_said_once`
    // is the same constraint that makes writing it twice a no-op.
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('messages')
            .select('messages.id')
            .whereRef('messages.conversation_id', '=', 'pc.id')
            .where(sql<boolean>`messages.key = 'gone/' || kid.id`),
        ),
      ),
    )
    .execute()

  let told = 0
  for (const one of gone) {
    const wrote = await db.transaction().execute(async (tx) => {
      const written = await note(tx, one.parentConversationId, `gone/${one.taskId}`, {
        activityType: ACTIVITY.handedBack,
        text: `Its machine, ${one.machineName}, is not here.`,
        goal: one.goal,
      })
      if (written) await wakeMachine(tx, one.parentMachineId)

      return written
    })
    if (wrote) told += 1
  }

  return told
}

/** One line of somebody's Inbox: a piece of work that stopped on them, and what it asked. */
export type Waiting = {
  readonly conversationId: string
  readonly spaceSlug: string
  readonly machineName: string
  readonly goal: string
  /** What it asked. Absent when it stopped without saying — which a page has to show as such. */
  readonly asked: string | null
  readonly since: Date
}

/**
 * Everything waiting on one person, across every Space they are in.
 *
 * The one place in this system that is not under a Space, and that is the whole point of it: work
 * you handed out is work you have to answer for wherever it happens to live. A person with three
 * Spaces has one Inbox.
 *
 * Only the ones a person owns — `parent_id is null`. What an agent handed to another agent is
 * answered by the agent that handed it out, and putting those here would be an Inbox nobody could
 * trust to mean "somebody has to do something".
 */
export async function waitingOn(db: Database, userId: string): Promise<readonly Waiting[]> {
  const rows = await db
    .selectFrom('tasks')
    .innerJoin('conversations', 'conversations.id', 'tasks.conversation_id')
    .innerJoin('spaces', 'spaces.id', 'conversations.space_id')
    .innerJoin('machines', 'machines.id', 'conversations.machine_id')
    // Joined rather than trusted: the owner is who it stopped on, but somebody taken out of a
    // Space should stop seeing what is happening in it, whoever they used to be.
    .innerJoin('memberships', (join) =>
      join
        .onRef('memberships.space_id', '=', 'spaces.id')
        .on('memberships.user_id', '=', userId)
        // An Inbox is what is waiting on you *here*. Work in a Space somebody has left is not
        // theirs to answer any more, and a row they cannot open is worse than no row.
        .on('memberships.revoked_at', 'is', null),
    )
    .select((eb) => [
      'conversations.id as conversationId',
      'spaces.slug as spaceSlug',
      'machines.name as machineName',
      'tasks.goal',
      'tasks.created_at as since',
      // What it asked, read one row at a time from the conversation it asked in. Bounded by how
      // many things are waiting on one person, which is a number a person has to live with.
      eb
        .selectFrom('messages')
        .select(sql<string | null>`content ->> 'text'`.as('asked'))
        .whereRef('messages.conversation_id', '=', 'conversations.id')
        .where('messages.role', '=', 'activity')
        .where(sql<boolean>`messages.content ->> 'activityType' = ${ACTIVITY.asked}`)
        .orderBy('messages.seq', 'desc')
        .limit(1)
        .as('asked'),
    ])
    .where('tasks.owner_user_id', '=', userId)
    .where('tasks.state', '=', STATE.wait)
    .where('tasks.parent_id', 'is', null)
    .orderBy('tasks.created_at', 'desc')
    .execute()

  return rows
}

/** The piece of work underway in a conversation, as its page shows it. */
export type Underway = {
  readonly task: Task
  /** Its own machine, so a page can say the same thing about this one it says about its children. */
  readonly whereabouts: Whereabouts
  /** The instant every whereabouts here is read against, from the clock that wrote them. */
  readonly asOf: Date
  /** Still open, so the one that handed them off is waiting on them. */
  readonly handedOff: readonly HandedOff[]
  readonly outputs: readonly Written[]
  /** The one that handed this out, when an agent did. Null when a person did. */
  readonly under: { readonly conversationId: string; readonly goal: string } | null
}

type HandedOff = {
  readonly conversationId: string
  readonly goal: string
  readonly state: State
  readonly machineName: string
  readonly agentKind: string
  /**
   * Where its machine was last heard from, and when this was read.
   *
   * Carried rather than worked out here, for the same reason the machines list carries it: whether
   * a machine counts as here is one rule, and it lives in `machine/presence.ts`. A page that has
   * both can say "its machine is not here" about a piece of work that will not move again — which
   * is the difference between waiting and being stuck.
   */
  readonly whereabouts: Whereabouts
}

type Written = {
  readonly title: string
  readonly body: string
  readonly writtenAt: Date
}

/** Everything about the piece of work in one conversation, or nothing when it is just talk. */
export async function underwayIn(
  db: Database | Tx,
  conversationId: string,
): Promise<Underway | undefined> {
  const task = (await db
    .selectFrom('tasks')
    .select(TASK_COLUMNS)
    .where('conversation_id', '=', conversationId)
    .where('ended_at', 'is', null)
    .executeTakeFirst()) as Task | undefined

  if (task === undefined) return undefined

  const mine = await itsMachine(db, conversationId)

  return {
    task,
    whereabouts: { lastSeenAt: mine.lastSeenAt, leftAt: mine.leftAt },
    asOf: mine.asOf,
    handedOff: await whatItHandedOut(db, task.id),
    outputs: await whatItWrote(db, task.id),
    under: await whatItIsUnder(db, task.parentId),
  }
}

/**
 * The machine this conversation is on, and the instant to read every whereabouts against.
 *
 * `asOf` from the same clock that wrote `last_seen_at`. A `new Date()` here would be this process
 * deciding a fact the database recorded, and the two clocks disagree by however far they drift.
 */
async function itsMachine(db: Database | Tx, conversationId: string) {
  return db
    .selectFrom('conversations')
    .innerJoin('machines', 'machines.id', 'conversations.machine_id')
    .select([
      'machines.last_seen_at as lastSeenAt',
      'machines.left_at as leftAt',
      sql<Date>`now()`.as('asOf'),
    ])
    .where('conversations.id', '=', conversationId)
    .executeTakeFirstOrThrow()
}

/** What it handed out, oldest first, each with the machine it landed on. */
async function whatItHandedOut(db: Database | Tx, taskId: string): Promise<readonly HandedOff[]> {
  const rows = await db
    .selectFrom('tasks')
    .innerJoin('conversations', 'conversations.id', 'tasks.conversation_id')
    .innerJoin('machines', 'machines.id', 'conversations.machine_id')
    .select([
      'tasks.conversation_id as conversationId',
      'tasks.goal',
      'tasks.state',
      'machines.name as machineName',
      'conversations.agent_kind as agentKind',
      'machines.last_seen_at as lastSeenAt',
      'machines.left_at as leftAt',
    ])
    .where('tasks.parent_id', '=', taskId)
    .orderBy('tasks.created_at')
    .execute()

  return rows.map((one) => ({
    conversationId: one.conversationId,
    goal: one.goal,
    state: one.state as State,
    machineName: one.machineName,
    agentKind: one.agentKind,
    whereabouts: { lastSeenAt: one.lastSeenAt, leftAt: one.leftAt },
  }))
}

/** What it wrote on purpose, newest first. */
async function whatItWrote(db: Database | Tx, taskId: string): Promise<readonly Written[]> {
  return db
    .selectFrom('outputs')
    .select(['title', 'body', 'updated_at as writtenAt'])
    .where('task_id', '=', taskId)
    .orderBy('updated_at', 'desc')
    .execute()
}

/** The piece of work that handed this one out, when an agent did. */
async function whatItIsUnder(db: Database | Tx, parentId: string | null) {
  if (parentId === null) return null

  const parent = await db
    .selectFrom('tasks')
    .select(['conversation_id as conversationId', 'goal'])
    .where('id', '=', parentId)
    .executeTakeFirst()

  return parent ?? null
}
