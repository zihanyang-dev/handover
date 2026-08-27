/**
 * A conversation: opening one, saying something into it, and reading it back.
 *
 * What one line of it is made of is `message.ts`, and what is being run in it is `turn.ts`. This
 * file is the conversation itself — the thing a person opens, talks into and scrolls.
 *
 * Reads take no locks. Every path that writes takes them in this order:
 *   1. the `conversations` row, so only one writer at a time decides what comes next
 *   2. the `messages` rows appended under it
 */

import { sql } from 'kysely'
import type { AgentKind } from '../machine/agent-kind.ts'
import { presence } from '../machine/presence.ts'
import { working, type Working } from '../conversation/busy.ts'
import {
  ACTIVITY,
  ENDINGS,
  type Asked,
  type Message,
  type Reported,
} from '../conversation/transcript.ts'
import type { Database, Tx } from './connection.ts'
import { append, alreadySaid, held, type Saying, type Said, type Speaking } from './message.ts'
import { endTurn, openTurn, owedAnAnswer, stillOwed } from './turn.ts'
import { backToWork, openTaskOn, underwayIn, waitsForAPerson, type Underway } from './task.ts'
import { reachableFrom, stillItsToWriteOn } from './machine.ts'
import { wakeMachine } from './waking.ts'

export type { Saying, Said, Speaking } from './message.ts'

export type Opening = {
  readonly spaceId: string
  readonly machineId: string
  readonly agentKind: AgentKind
}

export type Opened =
  | { readonly kind: 'opened'; readonly conversationId: string }
  /** No machine by that id can be reached from this Space, or it was removed. Pick another. */
  | { readonly kind: 'no-machine' }
  /** The machine is here but that agent is not on it any more. Install it, or pick another. */
  | { readonly kind: 'no-agent' }

/**
 * Opens a conversation with one agent on one machine.
 *
 * Both facts are checked under the machine's lock rather than read first and decided here: a
 * machine removed between the read and the insert would leave a conversation pinned to something
 * nobody can reach, and the only way out of that would be to delete it again.
 */
export async function openConversation(db: Database, opening: Opening): Promise<Opened> {
  return db.transaction().execute(async (tx) => {
    const machine = await tx
      .selectFrom('machines')
      .select(['machines.id'])
      .where('machines.id', '=', opening.machineId)
      .where('machines.removed_at', 'is', null)
      .where(reachableFrom(opening.spaceId))
      .forUpdate()
      .executeTakeFirst()

    if (machine === undefined) return { kind: 'no-machine' }

    const agent = await tx
      .selectFrom('agents')
      .select(['kind'])
      .where('machine_id', '=', machine.id)
      .where('kind', '=', opening.agentKind)
      .executeTakeFirst()

    if (agent === undefined) return { kind: 'no-agent' }

    const opened = await tx
      .insertInto('conversations')
      .values({
        space_id: opening.spaceId,
        machine_id: machine.id,
        agent_kind: opening.agentKind,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    return { kind: 'opened', conversationId: opened.id }
  })
}

/**
 * Adds one message a person said, interrupting the agent if it is in the middle of something.
 *
 * All of it in one transaction under the conversation's lock: whether it is busy, the request to
 * stop, and the words. Each of those stops being true the moment anybody else writes, and a stop
 * written without the message it was written for would be an agent stopped for no reason.
 */
export async function sayTo(db: Database, saying: Speaking, asked: Asked): Promise<Said> {
  return db.transaction().execute(async (tx) => {
    const conversation = await held(tx, saying)
    if (conversation === undefined) return { kind: 'no-conversation' }

    // Before anything about the state of the conversation: a message that is already in it landed
    // the first time, and the only reason it is being sent again is that nobody heard so. Asking
    // whether the agent is busy first would answer a question nobody asked — and answer it with
    // "you cannot say that", about something already said.
    if (await alreadySaid(tx, saying)) return { kind: 'said-already' }

    // Refused rather than queued: somebody is waiting for an answer, and a message that will sit
    // until a laptop opens again is worse than being told now that nobody is there.
    const machine = presence(conversation, conversation.asOf)
    if (machine.state === 'gone') return { kind: 'machine-away' }

    // Saying something to an agent that is working is interrupting it, and it is written down as
    // exactly that: the request to stop, and then the words. Queued instead, somebody who says
    // "no, leave legacy/ alone" watches it go on editing legacy/ until the step it was already on
    // happens to end — which is the one thing they were trying to prevent.
    const busy = working(await owedAnAnswer(tx, conversation.id), machine)
    // Under a name of its own, derived from this message's: asking twice is one interruption,
    // and the message keeps the name its sender gave it.
    if (busy.state === 'working') await askItToStop(tx, saying, `${saying.key}/stop`)

    const said = await append(tx, {
      ...saying,
      message: { role: 'user', content: asked },
      saidBy: saying.saidBy,
    })
    // In the same transaction as the message, so it is delivered when that commits: woken any
    // earlier, the machine would look, find nothing, and go back to waiting for the very thing it
    // was woken for. And a piece of work that was waiting on this person is waiting no longer —
    // the two are one call, so neither can be done without the other.
    if (said.kind === 'said') await backToWork(tx, conversation.id, conversation.machineId)

    return said
  })
}

export type Stopping =
  | { readonly kind: 'asked-to-stop' }
  /** The same request again. It was already asked, and asking twice changes nothing. */
  | { readonly kind: 'asked-already' }
  | { readonly kind: 'no-conversation' }
  /** Nothing is running. There is no way to stop something that already stopped. */
  | { readonly kind: 'nothing-to-stop' }

/**
 * Records that somebody asked the agent to stop.
 *
 * A message rather than a flag, because it is a thing a person did and the transcript is the
 * record of what people did. That it then stopped is a second message: asking and stopping are
 * two facts, and a turn that was asked to stop and did not is exactly the case worth being able
 * to see.
 *
 * Its own path rather than {@link sayTo}'s, though both write the same activity: this one is
 * refused when nothing is running, and saying something is not. Somebody who presses Stop on a
 * turn that just ended wants to hear that it already stopped; somebody who types a sentence wants
 * it said either way.
 */
export async function askToStop(db: Database, saying: Saying): Promise<Stopping> {
  return db.transaction().execute(async (tx) => {
    const conversation = await held(tx, saying)
    if (conversation === undefined) return { kind: 'no-conversation' }
    if (await alreadySaid(tx, saying)) return { kind: 'asked-already' }

    const busy = working(
      await owedAnAnswer(tx, conversation.id),
      presence(conversation, conversation.asOf),
    )
    if (busy.state === 'idle') return { kind: 'nothing-to-stop' }

    await askItToStop(tx, saying, saying.key)
    // Somebody is watching a turn they want to end, so this is the wake that matters most: told
    // on the next report instead, a stop waits out however long the machine is being held for.
    await wakeMachine(tx, conversation.machineId)

    return { kind: 'asked-to-stop' }
  })
}

/**
 * Writes down that somebody asked the agent to stop.
 *
 * What a stop looks like belongs here, not to whoever asked for one: a caller that could hand in
 * the message could hand in any message, through a route that only takes a name. Its own name in
 * the conversation, so that asking twice — or asking by saying something — is one request.
 */
async function askItToStop(tx: Tx, saying: Saying, key: string): Promise<void> {
  await append(tx, {
    conversationId: saying.conversationId,
    key,
    message: { role: 'activity', content: { activityType: ACTIVITY.stopAsked } },
  })
}

/** A machine reporting something, which is one message it has to be the owner of. */
export type Reporting = {
  readonly conversationId: string
  readonly key: string
  /** Three kinds, not four. A machine cannot write a line under a person's name — {@link Reported}. */
  readonly message: Reported
  readonly machineId: string
}

/**
 * Adds one message the agent's machine reported.
 *
 * The machine is proved by its credential and matched against the conversation here, so a machine
 * cannot write into a conversation that was never given to it — the path says which conversation,
 * never which machine.
 */
export async function machineSays(db: Database, reporting: Reporting): Promise<Said> {
  return db.transaction().execute(async (tx) => {
    const conversation = await stillItsToWriteOn(tx, reporting)

    if (conversation === undefined) return { kind: 'no-conversation' }

    const written = await append(tx, reporting)

    // A line that was already here is a retry, and everything below already happened in the
    // transaction that wrote it. Carried on regardless, an ending retried under an old name ends
    // whichever turn is running *now* — which by then is a different question, still being
    // answered.
    if (written.kind === 'said-already') return written

    // The record and the ledger move together. An ending in the transcript with the turn still
    // open would leave a conversation that reads as finished and is still owed an answer — and
    // the machine would be handed the same question again on its next report.
    if (ends(reporting.message)) {
      const running = await openTurn(tx, reporting.conversationId)
      if (running !== undefined) await endTurn(tx, reporting.conversationId, running)
      // A turn that went wrong stops a piece of work that was handed over: whether it matters is
      // a person's to say, and an agent that is not handed a turn cannot try again on its own.
      if (wentWrong(reporting.message)) await waitsForAPerson(tx, reporting.conversationId)
      // This machine has just become free, and whatever it is holding open was answered "nothing"
      // because it was not. Waking it is how the next question starts now rather than in
      // twenty-five seconds.
      await wakeMachine(tx, reporting.machineId)
    }

    return written
  })
}

/** Whether this is the message that says how a turn went. */
function ends(message: Message): boolean {
  return message.role === 'activity' && ENDINGS.includes(message.content.activityType)
}

/**
 * Whether that ending was trouble, as opposed to a turn that simply finished.
 *
 * `cancelled` is not: somebody asked for it, and a conversation somebody handed over carries on
 * from an interruption the same way it carries on from anything else.
 */
function wentWrong(message: Message): boolean {
  if (message.role !== 'activity') return false

  return (
    message.content.activityType === ACTIVITY.failed ||
    message.content.activityType === ACTIVITY.unknown
  )
}

/**
 * Records what the agent calls this conversation.
 *
 * Written once and left alone. Both agents keep the same id when a later turn picks a conversation
 * up, and one that started over instead says so by its own means — overwriting here would lose the
 * pointer to the record of everything that came before.
 */
export async function noteAgentSession(
  db: Database,
  noting: { readonly conversationId: string; readonly machineId: string; readonly session: string },
): Promise<void> {
  await db
    .updateTable('conversations')
    .set({ agent_session_id: noting.session })
    .where('id', '=', noting.conversationId)
    .where('machine_id', '=', noting.machineId)
    .where('agent_session_id', 'is', null)
    .execute()
}

export type Standing = {
  readonly id: string
  readonly agentKind: string
  readonly machineId: string
  readonly machineName: string
  readonly startedAt: Date
  /** The first thing a person said, which is what a list of conversations has to show. */
  readonly opening: string | null
  /**
   * Who said it. Null when nobody has spoken yet, and on conversations opened before a line could
   * say who wrote it.
   */
  readonly startedBy: string | null
  readonly working: Working
}

/**
 * The conversations in a Space, and whether each is being worked on.
 *
 * `working` is computed from the ledger and the machine's silence rather than stored, for the same
 * reason presence is: a machine that is killed writes nothing on the way out.
 */
export async function conversationsIn(db: Database, spaceId: string): Promise<readonly Standing[]> {
  const rows = await db
    .selectFrom('conversations')
    .innerJoin('machines', 'machines.id', 'conversations.machine_id')
    .select((eb) => [
      'conversations.id',
      'conversations.agent_kind as agentKind',
      'conversations.machine_id as machineId',
      'machines.name as machineName',
      'conversations.created_at as startedAt',
      'machines.last_seen_at as lastSeenAt',
      'machines.left_at as leftAt',
      sql<Date>`now()`.as('asOf'),
      eb
        .selectFrom('messages')
        .select(sql<string | null>`content ->> 'text'`.as('opening'))
        .whereRef('messages.conversation_id', '=', 'conversations.id')
        .where('messages.role', '=', 'user')
        .orderBy('messages.seq')
        .limit(1)
        .as('opening'),
      // Whose it is, derived from the same line the opening comes from rather than stored on the
      // conversation. Stored, it would be a second copy of the author of one message and would
      // disagree with it the day anything about that line changes. `architecture.md` §2.
      eb
        .selectFrom('messages')
        .innerJoin('users', 'users.id', 'messages.said_by')
        .select('users.display_name as startedBy')
        .whereRef('messages.conversation_id', '=', 'conversations.id')
        .where('messages.role', '=', 'user')
        .orderBy('messages.seq')
        .limit(1)
        .as('startedBy'),
      stillOwed(sql.ref('conversations.id')).as('unfinished'),
    ])
    .where('conversations.space_id', '=', spaceId)
    .orderBy('conversations.created_at', 'desc')
    .execute()

  return rows.map((row) => ({
    ...row,
    working: working(row.unfinished, presence(row, row.asOf)),
  }))
}

export type Reading = {
  readonly id: string
  readonly agentKind: string
  readonly machineName: string
  readonly working: Working
  /**
   * What this agent lets a person choose, as its machine last reported it.
   *
   * Read here rather than from the machines list, because this is the one question the page has:
   * not "what is on that machine" but "what can I choose for the thing I am about to say". Left
   * unread, like a message's content — the layer that puts it on the wire answers for its shape.
   */
  readonly offers: unknown
  /** Everything since what the reader said it had, or the whole of it when they said nothing. */
  readonly messages: readonly Stored[]
  /** The piece of work running in it, if somebody handed it over. Nothing when it is just talk. */
  readonly underway: Underway | undefined
}

/**
 * One line as the column holds it, unread.
 *
 * Not `Spoken`, which is what one becomes once it has been read: the whole point of this shape is
 * that nobody here has looked inside `content` yet, and the two names would be two ways of saying
 * a thing has and has not been checked.
 */
type Stored = {
  readonly seq: number
  readonly role: string
  readonly content: unknown
  readonly at: Date
}

/**
 * Whether this conversation is one this Space can reach.
 *
 * The same question {@link conversationWith} answers on its way to reading a transcript, asked on
 * its own by whoever only needs the answer. Watching a turn is the case: holding a stream open
 * begins by asking whether there is anything to watch, and asking it by reading the whole
 * conversation would load an hour of somebody's history to throw all of it away.
 */
export async function conversationInSpace(
  db: Database,
  reading: { readonly conversationId: string; readonly spaceId: string },
): Promise<boolean> {
  const found = await db
    .selectFrom('conversations')
    .select('id')
    .where('id', '=', reading.conversationId)
    .where('space_id', '=', reading.spaceId)
    .executeTakeFirst()

  return found !== undefined
}

/**
 * One conversation and everything said in it, in order.
 *
 * All of it in one transaction, for the same reason the machines list is: three statements are
 * three moments, and a turn that ends between the first and the third gives back a transcript
 * with no ending in it beside a `working` that says it is over. Both halves would be true; the
 * reading would not.
 */
export async function conversationWith(
  db: Database,
  reading: ToRead,
): Promise<Reading | undefined> {
  return db.transaction().execute(async (tx) => oneReading(tx, reading))
}

/**
 * Which conversation, and how much of it is already known.
 *
 * `after` is what a reader already has, by the number of the last line it holds. A transcript is
 * only ever appended to, so everything past that number is everything it is missing — and asking
 * again for what it already has would be this page downloading an hour of somebody's work every
 * second for as long as they watch it.
 */
export type ToRead = {
  readonly conversationId: string
  readonly spaceId: string
  readonly after?: number | undefined
}

async function oneReading(tx: Tx, reading: ToRead): Promise<Reading | undefined> {
  const conversation = await tx
    .selectFrom('conversations')
    .innerJoin('machines', 'machines.id', 'conversations.machine_id')
    // Left, not inner: an agent that has been uninstalled since leaves the conversation readable,
    // with nothing to choose. Its transcript is still what happened.
    .leftJoin('agents', (join) =>
      join
        .onRef('agents.machine_id', '=', 'conversations.machine_id')
        .onRef('agents.kind', '=', 'conversations.agent_kind'),
    )
    .select([
      'conversations.id',
      'conversations.agent_kind as agentKind',
      'machines.name as machineName',
      'machines.last_seen_at as lastSeenAt',
      'machines.left_at as leftAt',
      'agents.models as offers',
      sql<Date>`now()`.as('asOf'),
    ])
    .where('conversations.id', '=', reading.conversationId)
    .where('conversations.space_id', '=', reading.spaceId)
    .executeTakeFirst()

  if (conversation === undefined) return undefined

  const from = tx
    .selectFrom('messages')
    // The name and not the id: a page shows a person, and looking each one up afterwards would be
    // a second read per line of transcript. Null on the three kinds nobody said, and on lines
    // written before a line could say who wrote it.
    .leftJoin('users', 'users.id', 'messages.said_by')
    .select([
      'messages.seq',
      'messages.role',
      'messages.content',
      'messages.created_at as at',
      'users.display_name as said',
    ])
    .where('messages.conversation_id', '=', conversation.id)
    .orderBy('messages.seq')

  const messages = await (
    reading.after === undefined ? from : from.where('messages.seq', '>', reading.after)
  ).execute()

  return {
    ...conversation,
    working: working(
      await owedAnAnswer(tx, conversation.id),
      presence(conversation, conversation.asOf),
    ),
    messages,
    underway: await underwayIn(tx, conversation.id),
  }
}

export type HandedOff =
  | { readonly kind: 'handed-off'; readonly conversationId: string; readonly taskId: string }
  /** No machine by that name can be reached from this Space, or it was removed. */
  | { readonly kind: 'no-machine' }
  /** That machine is here but does not have that agent. */
  | { readonly kind: 'no-agent' }
  /** This machine is not running a piece of work in that conversation. */
  | { readonly kind: 'nothing-to-hand-off' }

export type HandingOff = {
  readonly conversationId: string
  readonly machineId: string
  readonly key: string
  /** The machine to hand it to, by the name a person sees in the Space. */
  readonly machine: string
  readonly agentKind: AgentKind
  readonly goal: string
}

/**
 * One agent opens a piece of work for another.
 *
 * A new conversation, because it is a different agent on a different machine — and `03` settled
 * that changing the agent means changing the conversation. Nothing about this being a sub-task
 * makes that so; it is the same rule everything else follows.
 *
 * Its owner is the agent that opened it, which is `parent_id` and nothing else. That is why what
 * it asks never reaches a person's Inbox: it is not asking them.
 *
 * Handing off does not stop the one handing off. It is free to open a second, and a third — what
 * stops it is its own turn ending while any of them are still open, which is counted rather than
 * declared.
 */
export async function handOffTo(db: Database, handing: HandingOff): Promise<HandedOff> {
  return db.transaction().execute(async (tx) => {
    const mine = await tx
      .selectFrom('conversations')
      .select(['id', 'space_id as spaceId'])
      .where('id', '=', handing.conversationId)
      .where('machine_id', '=', handing.machineId)
      .forUpdate()
      .executeTakeFirst()

    if (mine === undefined) return { kind: 'nothing-to-hand-off' }

    const parent = await openTaskOn(tx, mine.id)
    if (parent === undefined) return { kind: 'nothing-to-hand-off' }

    const to = await agentNamed(tx, mine.spaceId, handing)
    if (typeof to !== 'string') return to

    const opened = await tx
      .insertInto('conversations')
      .values({ space_id: mine.spaceId, machine_id: to, agent_kind: handing.agentKind })
      .returning('id')
      .executeTakeFirstOrThrow()

    const task = await tx
      .insertInto('tasks')
      .values({
        conversation_id: opened.id,
        parent_id: parent.id,
        // The person on the hook is still the person: an agent handing work to an agent does not
        // change who has to answer for it. What changes is who its questions go to.
        owner_user_id: parent.ownerUserId,
        goal: handing.goal,
        state: 'working',
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    await bothSides(tx, handing, { mine: mine.id, theirs: opened.id })
    await wakeMachine(tx, to)

    return { kind: 'handed-off', conversationId: opened.id, taskId: task.id }
  })
}

/**
 * The machine an agent named, if that agent is on it and this Space can reach it.
 *
 * Both under the machine's lock rather than read and then decided on, for the same reason opening
 * a conversation is: a machine removed between the read and the insert would leave a piece of
 * work pinned to something nobody can reach.
 */
async function agentNamed(
  tx: Tx,
  spaceId: string,
  handing: HandingOff,
): Promise<string | Extract<HandedOff, { kind: 'no-machine' | 'no-agent' }>> {
  const to = await tx
    .selectFrom('machines')
    .select('machines.id')
    .where('machines.name', '=', handing.machine)
    .where('machines.removed_at', 'is', null)
    .where(reachableFrom(spaceId))
    // Two people in one Space can both have a laptop called `mbp`. Oldest wins, so the same name
    // means the same machine every time rather than whichever row came back first.
    .orderBy('machines.created_at')
    .forUpdate()
    .executeTakeFirst()

  if (to === undefined) return { kind: 'no-machine' }

  const agent = await tx
    .selectFrom('agents')
    .select('kind')
    .where('machine_id', '=', to.id)
    .where('kind', '=', handing.agentKind)
    .executeTakeFirst()

  return agent === undefined ? { kind: 'no-agent' } : to.id
}

/**
 * The two lines a hand-off leaves: one where it came from, one where it landed.
 *
 * The one that landed is an activity rather than something said, and nobody said it — a
 * conversation whose only line is an unanswered question is one this deployment would go on
 * trying to answer for ever, long after somebody took the work back.
 */
async function bothSides(
  tx: Tx,
  handing: HandingOff,
  where: { readonly mine: string; readonly theirs: string },
): Promise<void> {
  await append(tx, {
    conversationId: where.theirs,
    key: 'handed-over',
    message: {
      role: 'activity',
      content: { activityType: ACTIVITY.handedOver, text: handing.goal },
    },
  })

  await append(tx, {
    conversationId: where.mine,
    key: handing.key,
    message: {
      role: 'activity',
      content: {
        activityType: ACTIVITY.handedOff,
        text: handing.goal,
        conversationId: where.theirs,
      },
    },
  })
}
