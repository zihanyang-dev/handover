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
 * **Nothing here reads the transcript to decide anything.** The transcript is the open half of this
 * system, where a new kind of activity is a value rather than a release; deciding on it would mean
 * the next activity anybody adds silently wakes every waiting piece of work, with nothing to say so.
 */

import { sql } from 'kysely'
import { ACTIVITY } from '../conversation/transcript.ts'
import type { Database, Tx } from './connection.ts'
import { append, held, type Saying } from './message.ts'
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

export type State = (typeof STATE)[keyof typeof STATE]

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

/** One activity, under a name that makes writing it twice write it once. */
async function note(
  tx: Tx,
  conversationId: string,
  key: string,
  content: { readonly activityType: string } & Record<string, unknown>,
): Promise<void> {
  await append(tx, { conversationId, key, message: { role: 'activity', content } })
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
 * The whole subtree, because the alternative is an orphan: what it handed off is still changing
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

    const stopped = await sql<{ id: string; conversationId: string; machineId: string }>`
      with recursive tree as (
        select id from tasks where id = ${root.id} and ended_at is null
        union all
        select t.id from tasks t join tree on t.parent_id = tree.id where t.ended_at is null
      ),
      over as (
        update tasks set state = ${STATE.done}, ended_at = now(), sleep_until = null
         where id in (select id from tree)
        returning id, conversation_id
      )
      select o.id, o.conversation_id as "conversationId", c.machine_id as "machineId"
        from over o join conversations c on c.id = o.conversation_id
    `.execute(tx)

    for (const one of stopped.rows) {
      // Named after the piece of work rather than after the request, so the one conversation the
      // person is looking at and the ones underneath it each get their line exactly once.
      await note(tx, one.conversationId, `${saying.key}/${one.id}`, {
        activityType: ACTIVITY.takenBack,
      })
      // Woken, not asked to stop: whatever is running on it is a turn, and a turn on a piece of
      // work that is over is one nobody will read. The machine finds nothing owed and lets go.
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
    const conversation = await tx
      .selectFrom('conversations')
      .select('id')
      .where('id', '=', reporting.conversationId)
      .where('machine_id', '=', reporting.machineId)
      .forUpdate()
      .executeTakeFirst()

    return conversation === undefined ? { kind: 'nothing-to-report' } : change(tx, conversation.id)
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
export type Stopping =
  /** It asked whoever handed this out. Only they start it again. */
  | { readonly state: 'wait'; readonly question: string }
  /** It is waiting out a moment. Only the clock starts it again. */
  | { readonly state: 'sleep'; readonly until: Date }
  /** Over, one way or the other. Nothing starts it again. */
  | { readonly state: 'done'; readonly ending: Ending; readonly said: string }

/** How a piece of work ended, in the words a person reads. */
export type Ending = 'done' | 'cannot'

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
  how: Stopping,
): Promise<Reported> {
  return reports(db, reporting, async (tx, task) => {
    await moveTo(tx, task, how.state, how.state === 'sleep' ? how.until : null)
    await note(tx, task.conversationId, reporting.key, said(how))
    await tellWhoeverWasWaiting(tx, task, how)

    return { kind: 'noted' }
  })
}

/** The moment, for a person reading the conversation later. */
function said(how: Stopping): { readonly activityType: string } & Record<string, unknown> {
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
async function tellWhoeverWasWaiting(tx: Tx, task: Task, how: Stopping): Promise<void> {
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
      ended_at: state === STATE.done ? sql<Date>`now()` : null,
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
          .doUpdateSet({ body: written.body, updated_at: sql<Date>`now()` }),
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
      join.onRef('memberships.space_id', '=', 'spaces.id').on('memberships.user_id', '=', userId),
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
  /** Still open, so the one that handed them off is waiting on them. */
  readonly handedOff: readonly HandedOff[]
  readonly outputs: readonly Written[]
  /** The one that handed this out, when an agent did. Null when a person did. */
  readonly under: { readonly conversationId: string; readonly goal: string } | null
}

export type HandedOff = {
  readonly conversationId: string
  readonly goal: string
  readonly state: State
  readonly machineName: string
  readonly agentKind: string
}

export type Written = {
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

  const handedOff = await db
    .selectFrom('tasks')
    .innerJoin('conversations', 'conversations.id', 'tasks.conversation_id')
    .innerJoin('machines', 'machines.id', 'conversations.machine_id')
    .select([
      'tasks.conversation_id as conversationId',
      'tasks.goal',
      'tasks.state',
      'machines.name as machineName',
      'conversations.agent_kind as agentKind',
    ])
    .where('tasks.parent_id', '=', task.id)
    .orderBy('tasks.created_at')
    .execute()

  const outputs = await db
    .selectFrom('outputs')
    .select(['title', 'body', 'updated_at as writtenAt'])
    .where('task_id', '=', task.id)
    .orderBy('updated_at', 'desc')
    .execute()

  const under =
    task.parentId === null
      ? null
      : ((await db
          .selectFrom('tasks')
          .select(['conversation_id as conversationId', 'goal'])
          .where('id', '=', task.parentId)
          .executeTakeFirst()) ?? null)

  return { task, handedOff: handedOff as readonly HandedOff[], outputs, under }
}
