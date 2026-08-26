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
import { ACTIVITY, ENDINGS, type Asked, type Message } from '../conversation/transcript.ts'
import type { Database, Tx } from './connection.ts'
import { append, alreadySaid, held, unfinished, type Saying, type Said } from './message.ts'

export type { Saying, Said } from './message.ts'
import { endTurn, openTurn } from './turn.ts'
import { wakeMachine } from './waking.ts'

export type Opening = {
  readonly spaceId: string
  readonly machineId: string
  readonly agentKind: AgentKind
}

export type Opened =
  | { readonly kind: 'opened'; readonly conversationId: string }
  /** No such machine in this Space, or it was removed. Pick another one. */
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
      .select(['id'])
      .where('id', '=', opening.machineId)
      .where('space_id', '=', opening.spaceId)
      .where('removed_at', 'is', null)
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
 * Adds one message a person said, if the agent is free to hear it.
 *
 * The check and the write are one transaction under the conversation's lock, because "is it busy"
 * is answered by the last message and the answer stops being true the moment another one lands.
 */
export async function sayTo(db: Database, saying: Saying, asked: Asked): Promise<Said> {
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
    const busy = working(await unfinished(tx, conversation.id), machine)
    // Under a name of its own, derived from this message's: asking twice is one interruption,
    // and the message keeps the name its sender gave it.
    if (busy.state === 'working') await askItToStop(tx, saying, `${saying.key}/stop`)

    const said = await append(tx, { ...saying, message: { role: 'user', content: asked } })
    // In the same transaction as the message, so it is delivered when that commits: woken any
    // earlier, the machine would look, find nothing, and go back to waiting for the very thing it
    // was woken for.
    if (said.kind === 'said') await wakeMachine(tx, conversation.machineId)

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
 * Allowed while the turn is open — which is the only time it means anything — so it deliberately
 * does not go through {@link sayTo}, whose whole job is to refuse things said over a live turn.
 */
export async function askToStop(db: Database, saying: Saying): Promise<Stopping> {
  return db.transaction().execute(async (tx) => {
    const conversation = await held(tx, saying)
    if (conversation === undefined) return { kind: 'no-conversation' }
    if (await alreadySaid(tx, saying)) return { kind: 'asked-already' }

    const busy = working(
      await unfinished(tx, conversation.id),
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
  readonly message: Message
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
    // The machine is proved by its credential, matched against the conversation, and checked for
    // still being in its Space — all inside the transaction that writes. The middleware's check
    // happened before this opened, and a machine somebody removed in between must not get one
    // more line into a transcript.
    const conversation = await tx
      .selectFrom('conversations')
      .innerJoin('machines', 'machines.id', 'conversations.machine_id')
      .select('conversations.id')
      .where('conversations.id', '=', reporting.conversationId)
      .where('conversations.machine_id', '=', reporting.machineId)
      .where('machines.removed_at', 'is', null)
      .forUpdate()
      .executeTakeFirst()

    if (conversation === undefined) return { kind: 'no-conversation' }

    const written = await append(tx, reporting)

    // The record and the ledger move together. An ending in the transcript with the turn still
    // open would leave a conversation that reads as finished and is still owed an answer — and
    // the machine would be handed the same question again on its next report.
    if (ends(reporting.message)) {
      const running = await openTurn(tx, reporting.conversationId)
      if (running !== undefined) await endTurn(tx, reporting.conversationId, running)
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
      // Whether a question here is still owed an answer: one nobody has taken, or one a machine
      // took and has not ended.
      eb
        .exists(
          eb
            .selectFrom('messages')
            .leftJoin('turns', (join) =>
              join
                .onRef('turns.conversation_id', '=', 'messages.conversation_id')
                .onRef('turns.asked_seq', '=', 'messages.seq'),
            )
            .select('messages.seq')
            .whereRef('messages.conversation_id', '=', 'conversations.id')
            .where('messages.role', '=', 'user')
            .where('turns.ended_at', 'is', null),
        )
        .as('unfinished'),
    ])
    .where('conversations.space_id', '=', spaceId)
    .orderBy('conversations.created_at', 'desc')
    .execute()

  return rows.map((row) => ({
    ...row,
    // `exists` comes back as a boolean from Postgres; the driver's type is wider than the column.
    working: working(row.unfinished === true, presence(row, row.asOf)),
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
    .select(['seq', 'role', 'content', 'created_at as at'])
    .where('conversation_id', '=', conversation.id)
    .orderBy('seq')

  const messages = await (
    reading.after === undefined ? from : from.where('seq', '>', reading.after)
  ).execute()

  return {
    ...conversation,
    working: working(
      await unfinished(tx, conversation.id),
      presence(conversation, conversation.asOf),
    ),
    messages,
  }
}
