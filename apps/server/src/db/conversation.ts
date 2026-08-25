/**
 * Conversations and what was said in them.
 *
 * Reads take no locks. Every path that writes takes them in this order:
 *   1. the `conversations` row, so only one writer at a time decides what comes next
 *   2. the `messages` rows appended under it
 *
 * `forgetStranded` is the exception and says so where it is written: it closes turns on a machine
 * that has just started, when by definition nobody else is writing them.
 */

import { sql } from 'kysely'
import type { AgentKind } from '../machine/agent-kind.ts'
import { presence } from '../machine/presence.ts'
import { working, type LastWord, type Working } from '../conversation/busy.ts'
import { ACTIVITY, ENDINGS, type Asked, type Message } from '../conversation/transcript.ts'
import type { Database, Tx } from './connection.ts'

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

/** One message and where it goes. Everything a writer needs and nothing about who they are. */
type Appending = {
  readonly conversationId: string
  /** This message's name in this conversation. A repeat of it is the same message, not a second. */
  readonly key: string
  readonly message: Message
}

/** Something a person does to a conversation they are a member of the Space of. */
export type Saying = {
  readonly conversationId: string
  readonly spaceId: string
  readonly key: string
}

export type Said =
  | { readonly kind: 'said' }
  /** The same message again. Nothing was written the second time, and nothing needs to be. */
  | { readonly kind: 'said-already' }
  | { readonly kind: 'no-conversation' }
  /** It is still working on the last thing. Wait for it rather than stacking another on top. */
  | { readonly kind: 'still-answering' }
  /** Its machine is not here. Nobody would pick this up, so it is refused rather than queued. */
  | { readonly kind: 'machine-away' }

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

    const busy = working(await lastWord(tx, conversation.id), machine)
    if (busy.state === 'working') return { kind: 'still-answering' }

    return append(tx, { ...saying, message: { role: 'user', content: asked } })
  })
}

/**
 * The conversation, held for the rest of the transaction, and where its machine was as of now.
 *
 * One read rather than two, and one lock rather than a lock and a hope: whether the agent is busy
 * and whether its machine is here are both answered from this row, and both stop being true the
 * moment somebody else writes.
 */
async function held(tx: Tx, saying: Saying) {
  return tx
    .selectFrom('conversations')
    .innerJoin('machines', 'machines.id', 'conversations.machine_id')
    .select([
      'conversations.id',
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

async function alreadySaid(tx: Tx, saying: Saying): Promise<boolean> {
  const already = await tx
    .selectFrom('messages')
    .select('id')
    .where('conversation_id', '=', saying.conversationId)
    .where('key', '=', saying.key)
    .executeTakeFirst()

  return already !== undefined
}

/**
 * The last thing said, which is what says whether a turn is still open.
 *
 * Only an `activity` can close one, so only its `activityType` is read; every other role leaves
 * the turn as it found it.
 */
async function lastWord(tx: Tx, conversationId: string): Promise<LastWord> {
  const last = await tx
    .selectFrom('messages')
    .select(sql<string | null>`content ->> 'activityType'`.as('activityType'))
    .where('conversation_id', '=', conversationId)
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst()

  return last ?? null
}

/**
 * Puts one message at the end of a conversation.
 *
 * `seq` is read and written inside the caller's lock, so two writers cannot both believe they are
 * next. A repeat of a key that is already there is not an error: the first write is what the
 * caller wanted, and the only reason they are asking again is that they never heard so.
 */
async function append(tx: Tx, appending: Appending): Promise<Said> {
  const next = await tx
    .selectFrom('messages')
    .select(sql<number>`coalesce(max(seq), 0) + 1`.as('seq'))
    .where('conversation_id', '=', appending.conversationId)
    .executeTakeFirstOrThrow()

  const written = await tx
    .insertInto('messages')
    .values({
      conversation_id: appending.conversationId,
      seq: next.seq,
      key: appending.key,
      role: appending.message.role,
      content: JSON.stringify(appending.message.content),
    })
    .onConflict((conflict) => conflict.columns(['conversation_id', 'key']).doNothing())
    .returning('id')
    .executeTakeFirst()

  return written === undefined ? { kind: 'said-already' } : { kind: 'said' }
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
      await lastWord(tx, conversation.id),
      presence(conversation, conversation.asOf),
    )
    if (busy.state === 'idle') return { kind: 'nothing-to-stop' }

    // What a stop looks like belongs here, not to whoever asked for one: a caller that could hand
    // in the message could hand in any message, through a route that only takes a name.
    const stopped = { activityType: ACTIVITY.stopAsked }
    await append(tx, { ...saying, message: { role: 'activity', content: stopped } })

    return { kind: 'asked-to-stop' }
  })
}

/**
 * The conversation on this machine that somebody has asked it to stop, if there is one.
 *
 * Answered by whether anything ended the turn since, not by whether anything was said since: an
 * agent goes on working for as long as it takes the request to reach it, and every line it writes
 * in that time would otherwise bury the request that was meant to stop it.
 *
 * Nothing has to clear it. The turn ending is the answer, and until there is one the machine is
 * told again on every report — which is also what makes a request that arrived while the machine
 * was between reports arrive on the next one instead of being lost.
 */
export async function stopWantedOn(db: Database, machineId: string): Promise<string | undefined> {
  const wanted = await db
    .selectFrom('messages')
    .innerJoin('conversations', 'conversations.id', 'messages.conversation_id')
    .select('conversations.id as conversationId')
    .where('conversations.machine_id', '=', machineId)
    .where('messages.role', '=', 'activity')
    .where(sql<boolean>`messages.content ->> 'activityType' = ${ACTIVITY.stopAsked}`)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('messages as ended')
            .select('ended.id')
            .whereRef('ended.conversation_id', '=', 'messages.conversation_id')
            .whereRef('ended.seq', '>', 'messages.seq')
            .where('ended.role', '=', 'activity')
            .where(sql<boolean>`ended.content ->> 'activityType' = any(${sql.val(ENDINGS)})`),
        ),
      ),
    )
    .limit(1)
    .executeTakeFirst()

  return wanted?.conversationId
}

/**
 * Closes every turn this machine left open, saying nobody knows how they went.
 *
 * Called when a machine says it has just started, which is the one moment when an open turn on it
 * is certainly nobody's: killing the process that drives an agent does not kill the agent, so a
 * turn abandoned that way went on without anybody watching, and what it did is unknowable from
 * here.
 *
 * `unknown` and not `failed`, because the two ask different things of a person: a failed turn is
 * safe to ask for again, and this one may already have done everything it was asked.
 */
export async function forgetStranded(db: Database, machineId: string): Promise<number> {
  const closed = await sql<{ id: string }>`
    insert into messages (conversation_id, seq, key, role, content)
    select last.conversation_id,
           last.seq + 1,
           last.seq || '/end',
           'activity',
           ${JSON.stringify({ activityType: ACTIVITY.unknown })}::jsonb
      from (
        select distinct on (m.conversation_id) m.conversation_id, m.seq, m.role, m.content
          from messages m
          join conversations c on c.id = m.conversation_id
         where c.machine_id = ${machineId}
         order by m.conversation_id, m.seq desc
      ) as last
     where last.role <> 'user'
       and coalesce(last.content ->> 'activityType', '') <> all(${sql.val(ENDINGS)})
    on conflict do nothing
    returning id
  `.execute(db)

  return closed.rows.length
}

export type Waiting = {
  readonly conversationId: string
  readonly agentKind: string
  /** What the agent calls this conversation, when it has said so. Absent on the first turn. */
  readonly agentSession: string | null
  /**
   * Where the question sits in the conversation.
   *
   * Sent so the machine can name what it writes after it — a name built from the question it is
   * answering is one it can rebuild if a write goes unanswered and has to be sent again.
   */
  readonly askedSeq: number
  readonly asked: unknown
}

/**
 * The longest-waiting question on this machine, if it has one.
 *
 * A question is waiting exactly when it is the last thing said in its conversation. Nothing marks
 * it as taken: the machine that asks is the only one that could answer, and it answers by
 * appending, which is what stops it being the last thing said.
 */
export async function waitingOn(db: Database, machineId: string): Promise<Waiting | undefined> {
  const waiting = await db
    .selectFrom('messages')
    .innerJoin('conversations', 'conversations.id', 'messages.conversation_id')
    .select([
      'conversations.id as conversationId',
      'conversations.agent_kind as agentKind',
      'conversations.agent_session_id as agentSession',
      'messages.seq as askedSeq',
      'messages.content as asked',
    ])
    .where('conversations.machine_id', '=', machineId)
    .where('messages.role', '=', 'user')
    // Nothing said after it is what makes a question still a question.
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('messages as later')
            .select('later.id')
            .whereRef('later.conversation_id', '=', 'messages.conversation_id')
            .whereRef('later.seq', '>', 'messages.seq'),
        ),
      ),
    )
    .orderBy('messages.created_at')
    .limit(1)
    .executeTakeFirst()

  return waiting
}

/** A machine reporting something, which is an {@link Appending} it has to be the owner of. */
export type Reporting = Appending & { readonly machineId: string }

/**
 * Adds one message the agent's machine reported.
 *
 * The machine is proved by its credential and matched against the conversation here, so a machine
 * cannot write into a conversation that was never given to it — the path says which conversation,
 * never which machine.
 */
export async function machineSays(db: Database, reporting: Reporting): Promise<Said> {
  return db.transaction().execute(async (tx) => {
    const conversation = await tx
      .selectFrom('conversations')
      .select('id')
      .where('id', '=', reporting.conversationId)
      .where('machine_id', '=', reporting.machineId)
      .forUpdate()
      .executeTakeFirst()

    if (conversation === undefined) return { kind: 'no-conversation' }

    return append(tx, reporting)
  })
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
 * `working` is computed here from the last message and the machine's silence rather than stored,
 * for the same reason presence is: a machine that is killed writes nothing on the way out.
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
      // Whether anything has been said at all, and what closed the turn if anything did. Two
      // answers out of one row, which is why they are not two subqueries.
      eb
        .selectFrom('messages')
        .select(sql<string | null>`coalesce(content ->> 'activityType', '')`.as('closing'))
        .whereRef('messages.conversation_id', '=', 'conversations.id')
        .orderBy('messages.seq', 'desc')
        .limit(1)
        .as('closing'),
    ])
    .where('conversations.space_id', '=', spaceId)
    .orderBy('conversations.created_at', 'desc')
    .execute()

  return rows.map((row) => ({
    ...row,
    working: working(spoken(row.closing), presence(row, row.asOf)),
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
  readonly messages: readonly Spoken[]
}

type Spoken = {
  readonly seq: number
  readonly role: string
  readonly content: unknown
  readonly at: Date
}

/** One conversation and everything said in it, in order. */
export async function conversationWith(
  db: Database,
  reading: { readonly conversationId: string; readonly spaceId: string },
): Promise<Reading | undefined> {
  const conversation = await db
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

  const messages = await db
    .selectFrom('messages')
    .select(['seq', 'role', 'content', 'created_at as at'])
    .where('conversation_id', '=', conversation.id)
    .orderBy('seq')
    .execute()

  const last = messages.at(-1)
  const lastWord: LastWord = last === undefined ? null : { activityType: closingOf(last.content) }

  return {
    ...conversation,
    working: working(lastWord, presence(conversation, conversation.asOf)),
    messages,
  }
}

function closingOf(content: unknown): string | null {
  const named = (content as { activityType?: unknown } | null)?.activityType
  return typeof named === 'string' ? named : null
}

/**
 * The last word of a conversation, from a single value.
 *
 * A row with no messages comes back as SQL null; one whose last message is not an activity comes
 * back as the empty string. Both mean something different, and folding them together would show a
 * fresh question as an idle conversation.
 */
function spoken(closing: string | null): LastWord {
  return closing === null ? null : { activityType: closing === '' ? null : closing }
}
