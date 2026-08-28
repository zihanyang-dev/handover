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

import { sql, type ExpressionBuilder, type SelectQueryBuilder } from 'kysely'
import type { DB, Json } from '../../generated/db.ts'
import { working, type Working } from '../conversation/busy.ts'
import {
  ACTIVITY,
  Asked,
  ENDINGS,
  type Message,
  type Reported,
} from '../conversation/transcript.ts'
import type { AgentKind } from '../machine/agent-kind.ts'
import { presence } from '../machine/presence.ts'
import type { Database, Tx } from './connection.ts'
import { reachableFrom, stillItsToWriteOn } from './machine.ts'
import { append, alreadySaid, type Saying, type Said, type Speaking } from './message.ts'
import { backToWork, openTaskOn, underwayIn, waitsForAPerson, type Underway } from './task.ts'
import { endTurn, openTurn, owedAnAnswer, stillOwed } from './turn.ts'
import { wakeMachine } from './waking.ts'

export type { Saying, Said, Speaking } from './message.ts'

export type SaidToAgent = Said | { readonly kind: 'no-agent' }

/**
 * The conversation, held for the rest of the transaction, and where its machine was as of now.
 *
 * One read rather than two, and one lock rather than a lock and a hope: whether the agent is busy
 * and whether its machine is here are both answered from this row, and both stop being true the
 * moment somebody else writes.
 *
 * The machine is joined *under* the lock, so `for update` holds its row as well. That is
 * deliberate and load-bearing: without it, a machine can be removed between this read and the
 * write, and something lands on a machine nobody can reach. See `machineSays` for the same
 * bargain from the other side.
 */
export async function held(tx: Tx, saying: Saying) {
  return tx
    .selectFrom('conversations')
    .innerJoin('machines', 'machines.id', 'conversations.machine_id')
    .select([
      'conversations.id',
      'conversations.agent_kind as agentKind',
      'machines.id as machineId',
      'machines.last_seen_at as lastSeenAt',
      'machines.left_at as leftAt',
      sql<Date>`now()`.as('asOf'),
    ])
    .where('conversations.id', '=', saying.conversationId)
    .where('conversations.space_id', '=', saying.spaceId)
    .where('machines.removed_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
}

export type Beginning = {
  readonly spaceId: string
  readonly machineId: string
  readonly agentKind: AgentKind
  /** Made by the client, so a lost answer can be asked for again without asking twice. */
  readonly conversationId: string
  readonly saidBy: string
  readonly asked: Asked
  /**
   * A directory on that machine to work in, when a person has one in mind.
   *
   * Absent nearly always, and then the machine works somewhere of its own. Not checked here and
   * not checkable: this deployment has never seen that machine's disk, and a path that is wrong
   * is something the machine says on the turn it tries to use it.
   */
  readonly worksIn?: string | undefined
}

export type Begun =
  | { readonly kind: 'begun'; readonly conversationId: string }
  /** No machine by that id can be reached from this Space, or it was removed. Pick another. */
  | { readonly kind: 'no-machine' }
  /** The machine is here but that agent is not on it any more. Install it, or pick another. */
  | { readonly kind: 'no-agent' }
  /**
   * Its machine is not here, so nothing was written.
   *
   * Refused here and nowhere else. A conversation is pinned to one machine for as long as it
   * exists, so this is the last moment anybody can pick a different one — which is what the
   * recovery says. Saying something into a conversation that already exists is not refused for
   * this: there is no other machine to choose by then, and the words wait for the one it has.
   */
  | { readonly kind: 'machine-away' }
  /** That client-generated id already names a different intention. */
  | { readonly kind: 'id-taken' }

/**
 * Opens a conversation only when its first message can be written with it.
 *
 * The client-generated id is the idempotency key for this cross-row intention. A lost 201 may be
 * retried with that id and finds the message the committed transaction wrote; a click without a
 * message never calls this function and therefore has nothing to leave behind.
 */
export async function beginConversation(db: Database, beginning: Beginning): Promise<Begun> {
  return db.transaction().execute(async (tx) => {
    // There is no conversation row to lock yet. This transaction-scoped lock gives concurrent
    // retries of the client UUID one writer; unrelated conversations never wait on each other.
    await sql`select pg_advisory_xact_lock(hashtextextended(${beginning.conversationId}, 0))`.execute(
      tx,
    )

    const repeated = await openedBefore(tx, beginning)
    if (repeated !== undefined) return repeated

    const machine = await tx
      .selectFrom('machines')
      .select([
        'machines.id',
        'machines.last_seen_at as lastSeenAt',
        'machines.left_at as leftAt',
        sql<Date>`now()`.as('asOf'),
      ])
      .where('machines.id', '=', beginning.machineId)
      .where('machines.removed_at', 'is', null)
      .where(reachableFrom(beginning.spaceId))
      .forUpdate()
      .executeTakeFirst()

    if (machine === undefined) return { kind: 'no-machine' }
    if (presence(machine, machine.asOf).state === 'gone') return { kind: 'machine-away' }

    const agent = await tx
      .selectFrom('agents')
      .select('kind')
      .where('machine_id', '=', machine.id)
      .where('kind', '=', beginning.agentKind)
      .executeTakeFirst()
    if (agent === undefined) return { kind: 'no-agent' }

    await tx
      .insertInto('conversations')
      .values({
        id: beginning.conversationId,
        space_id: beginning.spaceId,
        machine_id: machine.id,
        agent_kind: beginning.agentKind,
        works_in: beginning.worksIn ?? null,
      })
      .execute()

    const said = await append(tx, {
      conversationId: beginning.conversationId,
      key: `opening:${beginning.conversationId}`,
      message: { role: 'user', content: beginning.asked },
      saidBy: beginning.saidBy,
    })
    if (said.kind !== 'said') throw new Error('a new conversation already had its first message')

    await backToWork(tx, beginning.conversationId, machine.id)
    return { kind: 'begun', conversationId: beginning.conversationId }
  })
}

/** The same client id after a lost response is the same opening, not another conversation. */
async function openedBefore(tx: Tx, beginning: Beginning): Promise<Begun | undefined> {
  const existing = await tx
    .selectFrom('conversations')
    .select(['space_id as spaceId', 'machine_id as machineId', 'agent_kind as agentKind'])
    .where('id', '=', beginning.conversationId)
    .forUpdate()
    .executeTakeFirst()
  if (existing === undefined) return undefined
  if (
    existing.spaceId !== beginning.spaceId ||
    existing.machineId !== beginning.machineId ||
    existing.agentKind !== beginning.agentKind
  )
    return { kind: 'id-taken' }

  const first = await tx
    .selectFrom('messages')
    .select(['role', 'content', 'said_by as saidBy'])
    .where('conversation_id', '=', beginning.conversationId)
    .where('key', '=', `opening:${beginning.conversationId}`)
    .executeTakeFirst()
  if (
    first === undefined ||
    first.role !== 'user' ||
    first.saidBy !== beginning.saidBy ||
    !sameQuestion(first.content, beginning.asked)
  )
    return { kind: 'id-taken' }

  return { kind: 'begun', conversationId: beginning.conversationId }
}

function sameQuestion(stored: Json, asked: Asked): boolean {
  const read = Asked.safeParse(stored)
  return (
    read.success &&
    read.data.text === asked.text &&
    read.data.model === asked.model &&
    read.data.effort === asked.effort
  )
}

/**
 * Adds one message a person said, interrupting the agent if it is in the middle of something.
 *
 * All of it in one transaction under the conversation's lock: whether it is busy, the request to
 * stop, and the words. Each of those stops being true the moment anybody else writes, and a stop
 * written without the message it was written for would be an agent stopped for no reason.
 */
export async function sayTo(db: Database, saying: Speaking, asked: Asked): Promise<SaidToAgent> {
  return db.transaction().execute(async (tx) => {
    const conversation = await held(tx, saying)
    if (conversation === undefined) return { kind: 'no-conversation' }

    // Before anything about the state of the conversation: a message that is already in it landed
    // the first time, and the only reason it is being sent again is that nobody heard so. Asking
    // whether the agent is busy first would answer a question nobody asked — and answer it with
    // "you cannot say that", about something already said.
    if (await alreadySaid(tx, saying)) return { kind: 'said-already' }

    // Written down whether or not its machine is awake, because nothing here is ever *sent* to a
    // machine: a machine asks, and `owedATurn` hands it everything said since its last turn. That
    // query asks only that the machine has not been removed — not that it is online — so a line
    // written while a laptop is shut is picked up the moment it opens.
    //
    // This used to be refused, which was written for one person talking to their own laptop. With
    // a second person in the Space it is somebody else's laptop, and refusing threw their words
    // away before anything was written down. Nobody else does that: Multica's daemon polls and
    // the server holds the work until it comes back, a GitHub Actions job for an offline
    // self-hosted runner queues, and a message to somebody offline is stored and delivered when
    // they reconnect. All three keep the words and show the sender that it is waiting.
    //
    // No expiry either, and for the same reason Multica has none: GitHub cancels a queued job
    // after a day and Signal drops an undelivered message after thirty, because both of those are
    // delivery buffers. A transcript is a record — the words stay, and what waits is the turn.
    const machine = presence(conversation, conversation.asOf)

    const agent = await tx
      .selectFrom('agents')
      .select('kind')
      .where('machine_id', '=', conversation.machineId)
      .where('kind', '=', conversation.agentKind)
      .executeTakeFirst()
    if (agent === undefined) return { kind: 'no-agent' }

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

export type StopAsked =
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
export async function askToStop(db: Database, saying: Saying): Promise<StopAsked> {
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
  /** This person's mark, not a property shared by everybody else in the Space. */
  readonly pinned: boolean
  readonly working: Working
}

/**
 * The conversations in a Space, and whether each is being worked on.
 *
 * `working` is computed from the ledger and the machine's silence rather than stored, for the same
 * reason presence is: a machine that is killed writes nothing on the way out.
 */
/**
 * What the first thing anybody said in a conversation says: the words, and whose they are.
 *
 * Both are read off that one line rather than stored on the conversation. Stored, each would be a
 * second copy of something one message already says, and would disagree with it the day anything
 * about that line changes. `architecture.md` §2.
 */
function theFirstLine(eb: ExpressionBuilder<DB, 'conversations'>) {
  const said = <T>(from: SelectQueryBuilder<DB, 'conversations' | 'messages' | 'users', T>) =>
    from
      .whereRef('messages.conversation_id', '=', 'conversations.id')
      .where('messages.role', '=', 'user')
      .orderBy('messages.seq')
      .limit(1)

  return [
    said(eb.selectFrom('messages').select(sql<string | null>`content ->> 'text'`.as('opening'))).as(
      'opening',
    ),
    said(
      eb
        .selectFrom('messages')
        .innerJoin('users', 'users.id', 'messages.said_by')
        .select('users.display_name as startedBy'),
    ).as('startedBy'),
  ]
}

export async function conversationsIn(
  db: Database,
  spaceId: string,
  userId: string,
): Promise<readonly Standing[]> {
  const rows = await db
    .selectFrom('conversations')
    .innerJoin('machines', 'machines.id', 'conversations.machine_id')
    .leftJoin('conversation_pins', (join) =>
      join
        .onRef('conversation_pins.conversation_id', '=', 'conversations.id')
        .on('conversation_pins.user_id', '=', userId),
    )
    .select((eb) => [
      'conversations.id',
      'conversations.agent_kind as agentKind',
      'conversations.machine_id as machineId',
      'machines.name as machineName',
      'conversations.created_at as startedAt',
      'conversation_pins.pinned_at as pinnedAt',
      'machines.last_seen_at as lastSeenAt',
      'machines.left_at as leftAt',
      sql<Date>`now()`.as('asOf'),
      ...theFirstLine(eb),
      stillOwed(sql.ref('conversations.id')).as('unfinished'),
    ])
    .where('conversations.space_id', '=', spaceId)
    .orderBy('conversations.created_at', 'desc')
    .execute()

  return rows.map((row) => ({
    id: row.id,
    agentKind: row.agentKind,
    machineId: row.machineId,
    machineName: row.machineName,
    startedAt: row.startedAt,
    opening: row.opening,
    startedBy: row.startedBy,
    pinned: row.pinnedAt !== null,
    working: working(row.unfinished, presence(row, row.asOf)),
  }))
}

/**
 * Marks a conversation for this person.
 *
 * The Space is part of the insert rather than trusted from the route. A conversation id from
 * somewhere else must not be accepted merely because the person also happens to belong there.
 * A second PUT is the same mark, so the original position is left alone rather than made recent.
 */
export async function pinConversation(
  db: Database,
  pin: { readonly spaceId: string; readonly conversationId: string; readonly userId: string },
): Promise<boolean> {
  const pinned = await db
    .insertInto('conversation_pins')
    .columns(['user_id', 'conversation_id'])
    .expression((eb) =>
      eb
        .selectFrom('conversations')
        .select([eb.val(pin.userId).as('user_id'), 'conversations.id as conversation_id'])
        .where('conversations.id', '=', pin.conversationId)
        .where('conversations.space_id', '=', pin.spaceId),
    )
    .onConflict((conflict) => conflict.columns(['user_id', 'conversation_id']).doNothing())
    .returning('conversation_id')
    .executeTakeFirst()

  if (pinned !== undefined) return true

  const already = await db
    .selectFrom('conversation_pins')
    .innerJoin('conversations', 'conversations.id', 'conversation_pins.conversation_id')
    .select('conversation_pins.conversation_id')
    .where('conversation_pins.user_id', '=', pin.userId)
    .where('conversation_pins.conversation_id', '=', pin.conversationId)
    .where('conversations.space_id', '=', pin.spaceId)
    .executeTakeFirst()

  return already !== undefined
}

/**
 * Removes only this person's mark. Missing already means unpinned, so DELETE is idempotent and
 * reveals nothing about a conversation id from another Space.
 */
export async function unpinConversation(
  db: Database,
  pin: { readonly spaceId: string; readonly conversationId: string; readonly userId: string },
): Promise<void> {
  await db
    .deleteFrom('conversation_pins')
    .where('user_id', '=', pin.userId)
    .where('conversation_id', 'in', (eb) =>
      eb
        .selectFrom('conversations')
        .select('id')
        .where('id', '=', pin.conversationId)
        .where('space_id', '=', pin.spaceId),
    )
    .execute()
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

/** Whether this person can still reach this conversation through this Space. */
export async function conversationReachableBy(
  db: Database,
  reading: { readonly conversationId: string; readonly spaceId: string; readonly userId: string },
): Promise<boolean> {
  const found = await db
    .selectFrom('conversations')
    .innerJoin('memberships', 'memberships.space_id', 'conversations.space_id')
    .select('conversations.id')
    .where('conversations.id', '=', reading.conversationId)
    .where('conversations.space_id', '=', reading.spaceId)
    .where('memberships.user_id', '=', reading.userId)
    .where('memberships.revoked_at', 'is', null)
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
  /** This machine does not have that agent. */
  | { readonly kind: 'no-agent' }
  /** This machine is not running a piece of work in that conversation. */
  | { readonly kind: 'nothing-to-hand-off' }
  /** It is itself something that was handed off. Only what a person owns may hand out more. */
  | { readonly kind: 'not-yours-to-hand-off' }

export type HandingOff = {
  readonly conversationId: string
  readonly machineId: string
  readonly key: string
  readonly agentKind: AgentKind
  readonly goal: string
}

/**
 * One agent opens a piece of work for another, here.
 *
 * A new conversation, because it is a different agent — and `03` settled that changing the agent
 * means changing the conversation. Nothing about this being a sub-task makes that so; it is the
 * same rule everything else follows.
 *
 * **Here**, and that is `prd.md` 07 ⑥. It used to name a machine, and any machine the Space could
 * reach would do — so an agent could put work on somebody's laptop at three in the morning with
 * nobody in the room and nothing to say who decided it. A person handing you something has a name
 * and a time against it; an agent doing it has neither. What is left is the same machine, which
 * is also what lets a sub-task read the files the work it belongs to has been writing.
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
    // Two levels and no more, `prd.md` 07 ⑤. A plan that fans out belongs with whoever has to
    // answer for it, not three deep where no person ever chose it — and every question about a
    // tree ("what does taking this back stop") becomes a question about a parent and its
    // children, which is one index seek rather than a walk.
    if (parent.parentId !== null) return { kind: 'not-yours-to-hand-off' }

    if (!(await hasAgent(tx, handing.machineId, handing.agentKind))) return { kind: 'no-agent' }

    const opened = await tx
      .insertInto('conversations')
      .values({
        space_id: mine.spaceId,
        // The same machine. Whatever it writes lands beside what its parent is writing, which is
        // the whole of how a sub-task sees the work it belongs to.
        machine_id: handing.machineId,
        agent_kind: handing.agentKind,
      })
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
    await wakeMachine(tx, handing.machineId)

    return { kind: 'handed-off', conversationId: opened.id, taskId: task.id }
  })
}

/** Whether this machine has the agent being asked for. What it reported, as of its last report. */
async function hasAgent(tx: Tx, machineId: string, kind: AgentKind): Promise<boolean> {
  const agent = await tx
    .selectFrom('agents')
    .select('kind')
    .where('machine_id', '=', machineId)
    .where('kind', '=', kind)
    .executeTakeFirst()

  return agent !== undefined
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
