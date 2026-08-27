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
import type { Tx } from './connection.ts'
import { noteWritten } from './watching.ts'

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

/** Somebody saying something: a {@link Saying}, and the person doing it. */
export type Speaking = Saying & { readonly saidBy: string }

export type Said =
  | { readonly kind: 'said' }
  /** The same message again. Nothing was written the second time, and nothing needs to be. */
  | { readonly kind: 'said-already' }
  | { readonly kind: 'no-conversation' }

/**
 * A line to add, and — when a person said it — which person.
 *
 * The two are given together or not at all, because the database says the same thing: a `user`
 * line has an author and no other kind has one. Written as two optional fields, the one call that
 * forgot would fail at run time in SQL, which is the right place for it to fail and the wrong
 * place to find out. `code-style.md` 4.4.
 */
export type Appending = {
  readonly conversationId: string
  /** This message's name in this conversation. A repeat of it is the same message, not a second. */
  readonly key: string
} & (
  | { readonly message: Extract<Message, { role: 'user' }>; readonly saidBy: string }
  | { readonly message: Exclude<Message, { role: 'user' }>; readonly saidBy?: undefined }
)

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
 * Puts one message at the end of a conversation.
 *
 * `seq` is read and written inside the caller's lock, so two writers cannot both believe they are
 * next. A repeat of a key that is already there is not an error: the first write is what the
 * caller wanted, and the only reason they are asking again is that they never heard so.
 *
 * Writing is also what tells whoever is watching, in this same transaction. Two places writing
 * the same fact — one into the table and one down a stream — is the mistake with a name, and the
 * name is a dual write: nothing joins the two, so they can disagree about what happened and about
 * what order it happened in. Here there is one write, and it announces itself when it commits.
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
      said_by: appending.saidBy ?? null,
    })
    .onConflict((conflict) => conflict.columns(['conversation_id', 'key']).doNothing())
    .returning('id')
    .executeTakeFirst()

  if (written === undefined) return { kind: 'said-already' }

  await noteWritten(tx, appending.conversationId, next.seq)

  return { kind: 'said' }
}
