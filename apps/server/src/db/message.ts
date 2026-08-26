/**
 * One line of a transcript: putting it there, finding it, and reading the two things a caller has
 * to know before writing another.
 *
 * The smallest thing either of the two records above it is built from. It is here on its own so
 * that neither has to import the other: a conversation writes messages and a turn writes messages,
 * and if the file that owned `append` also owned one of them, the other would have to reach
 * through it.
 */

import { sql } from 'kysely'
import type { Message } from '../conversation/transcript.ts'
import type { Database, Tx } from './connection.ts'

/**
 * Where a person is writing, and under what name.
 *
 * The Space is part of it: a conversation is reachable through the Space it belongs to, and one
 * that names a different Space is one this caller has no standing in.
 */
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

/** One message and where it goes. Everything a writer needs and nothing about who they are. */
export type Appending = {
  readonly conversationId: string
  /** This message's name in this conversation. A repeat of it is the same message, not a second. */
  readonly key: string
  readonly message: Message
}

/**
 * The conversation, held for the rest of the transaction, and where its machine was as of now.
 *
 * One read rather than two, and one lock rather than a lock and a hope: whether the agent is busy
 * and whether its machine is here are both answered from this row, and both stop being true the
 * moment somebody else writes.
 */
export async function held(tx: Tx, saying: Saying) {
  return tx
    .selectFrom('conversations')
    .innerJoin('machines', 'machines.id', 'conversations.machine_id')
    .select([
      'conversations.id',
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

export async function alreadySaid(tx: Tx, saying: Saying): Promise<boolean> {
  const already = await tx
    .selectFrom('messages')
    .select('id')
    .where('conversation_id', '=', saying.conversationId)
    .where('key', '=', saying.key)
    .executeTakeFirst()

  return already !== undefined
}

/**
 * Whether a question in this conversation is still owed an answer.
 *
 * A question with no turn is one nobody has taken; a question whose turn has not ended is one
 * being run. Both are owed. What was said after it decides nothing — the words are the record, and
 * whether the work is finished is the ledger's to say.
 */
export async function unfinished(db: Database | Tx, conversationId: string): Promise<boolean> {
  const owed = await db
    .selectFrom('messages')
    .leftJoin('turns', (join) =>
      join
        .onRef('turns.conversation_id', '=', 'messages.conversation_id')
        .onRef('turns.asked_seq', '=', 'messages.seq'),
    )
    .select('messages.seq')
    .where('messages.conversation_id', '=', conversationId)
    .where('messages.role', '=', 'user')
    .where('turns.ended_at', 'is', null)
    .limit(1)
    .executeTakeFirst()

  return owed !== undefined
}

/**
 * Puts one message at the end of a conversation.
 *
 * `seq` is read and written inside the caller's lock, so two writers cannot both believe they are
 * next. A repeat of a key that is already there is not an error: the first write is what the
 * caller wanted, and the only reason they are asking again is that they never heard so.
 */
export async function append(tx: Tx, appending: Appending): Promise<Said> {
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
