/**
 * Who is in a Space, and what they may do there.
 *
 * Two roles and no more. A table of roles would invite a third; Linear and Notion have no custom
 * roles at any tier and they are much larger than this. What an owner has that a member does not
 * is the short list at {@link ROLE}: asking people in, taking them out, and naming the place.
 *
 * Removing somebody writes down when, rather than deleting the row. Three products answer this
 * the same way — GitHub keeps a removed member for three months, Notion restores everything if
 * they rejoin within thirty days, Linear has no permanent delete at all — and keeping the row
 * means inviting the same person back puts them where they were, with no window that expires.
 */

import { expressionBuilder, sql, type Expression, type SqlBool } from 'kysely'
import type { DB } from '../../generated/db.ts'
import type { Database, Tx } from './connection.ts'
import { reachableFrom } from './machine.ts'

export const ROLE = {
  /** Asks people in, takes them out, names the Space, and makes other owners. */
  owner: 'owner',
  member: 'member',
} as const

export type Role = (typeof ROLE)[keyof typeof ROLE]

export type Member = {
  readonly userId: string
  readonly displayName: string
  readonly role: Role
  readonly since: Date
  /** Whether this is whoever is asking. A page cannot work that out from a name. */
  readonly you: boolean
}

export type Joined =
  | { readonly kind: 'joined'; readonly slug: string }
  /** Already in, which is what a second click on the same link is. */
  | { readonly kind: 'already-in'; readonly slug: string }

/**
 * Puts somebody in a Space, or says they were already.
 *
 * One statement, because two people following the same link at the same moment both run it: the
 * conflict is the second one, and it is not a failure — it is the same answer arriving twice.
 * Somebody who was removed and invited back lands on their old row, with whatever they had.
 */
export async function joins(
  db: Database,
  who: { readonly userId: string; readonly spaceId: string; readonly slug: string },
): Promise<Joined> {
  const put = await db
    .insertInto('memberships')
    .values({
      space_id: who.spaceId,
      user_id: who.userId,
      role: ROLE.member,
      // Every membership needs one, and joining by a link has no idempotency key of its own: the
      // unique on (space_id, user_id) is what makes a second click land once.
      request_key: `joined/${who.userId}`,
    })
    .onConflict((clash) =>
      clash
        .columns(['space_id', 'user_id'])
        .doUpdateSet({ revoked_at: null })
        .where('memberships.revoked_at', 'is not', null),
    )
    .returning('user_id')
    .executeTakeFirst()

  return { kind: put === undefined ? 'already-in' : 'joined', slug: who.slug }
}

/** Everybody here, oldest first, with whether each is the one asking. */
export async function membersOf(
  db: Database,
  spaceId: string,
  asking: string,
): Promise<readonly Member[]> {
  const rows = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select([
      'memberships.user_id as userId',
      'users.display_name as displayName',
      'memberships.role as role',
      'memberships.created_at as since',
    ])
    .where('memberships.space_id', '=', spaceId)
    .where('memberships.revoked_at', 'is', null)
    .orderBy('memberships.created_at')
    .execute()

  return rows.map((row) => ({ ...(row as Omit<Member, 'you'>), you: row.userId === asking }))
}

/** Whether this person may ask people in and take them out. */
export async function isOwner(
  db: Database | Tx,
  spaceId: string,
  userId: string,
): Promise<boolean> {
  const found = await db
    .selectFrom('memberships')
    .select('user_id')
    .where('space_id', '=', spaceId)
    .where('user_id', '=', userId)
    .where('role', '=', ROLE.owner)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()

  return found !== undefined
}

export type Moved =
  | { readonly kind: 'moved' }
  /** They are not here, so there is nothing to move. */
  | { readonly kind: 'not-a-member' }
  /**
   * It would have left the Space with nobody who can let anybody in.
   *
   * Caught here rather than allowed and apologised for, and the database catches it too — see the
   * deferred constraint in the migration. Two writers, one of which is this.
   */
  | { readonly kind: 'the-last-owner' }

/** Changes what somebody may do, or says why it would leave the Space without an owner. */
/**
 * Takes the Space's turn to change who owns it.
 *
 * The rule that a Space keeps an owner is a deferred trigger, and a deferred trigger runs at
 * commit — where it cannot see another transaction that has not committed yet. Two owners
 * demoting each other at the same moment each look across and see the other still an owner, both
 * pass, and the Space is left with none. No unique index can say "at least one", so nothing else
 * catches it.
 *
 * An advisory lock keyed on the Space, taken before the write, is what makes the trigger's
 * question meaningful: the second transaction waits, and asks after the first has committed. Same
 * shape and same reason as the lock `issueCode` takes on an address.
 *
 * Only the paths that can *take an owner away* need it. Joining and promoting can only add.
 */
async function itsTurnToChangeOwners(tx: Tx, spaceId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`owners:${spaceId}`}))`.execute(tx)
}

export async function becomes(
  db: Database,
  who: { readonly spaceId: string; readonly userId: string },
  role: Role,
): Promise<Moved> {
  return orTheLastOwner(async () =>
    db.transaction().execute(async (tx) => {
      await itsTurnToChangeOwners(tx, who.spaceId)

      const moved = await tx
        .updateTable('memberships')
        .set({ role })
        .where('space_id', '=', who.spaceId)
        .where('user_id', '=', who.userId)
        .where('revoked_at', 'is', null)
        .returning('user_id')
        .executeTakeFirst()

      return moved === undefined ? { kind: 'not-a-member' } : { kind: 'moved' }
    }),
  )
}

/**
 * Takes somebody out. Leaving is this too — a person removing themselves.
 *
 * Nothing they hold moves or stops: whoever is doing this has already been shown what that is and
 * has decided one at a time. Linear does not reassign a removed member's open issues either, and
 * Devin lets a running session finish; deciding for somebody is worse than asking them.
 */
export async function removes(
  db: Database,
  who: { readonly spaceId: string; readonly userId: string },
): Promise<Moved> {
  return orTheLastOwner(async () =>
    db.transaction().execute(async (tx) => {
      await itsTurnToChangeOwners(tx, who.spaceId)

      const out = await tx
        .updateTable('memberships')
        .set({ revoked_at: sql<Date>`clock_timestamp()` })
        .where('space_id', '=', who.spaceId)
        .where('user_id', '=', who.userId)
        .where('revoked_at', 'is', null)
        .returning('user_id')
        .executeTakeFirst()

      return out === undefined ? { kind: 'not-a-member' } : { kind: 'moved' }
    }),
  )
}

/** The name the migration raises under, which is how a refusal gets back here as an answer. */
const KEEPS_AN_OWNER = 'memberships_keep_an_owner'

/**
 * Turns the database's refusal into a word, rather than asking the same question first.
 *
 * Three paths can take the last owner away and this covers all three — because it is not a check
 * at all. The rule lives in one place, deferred to the end of the transaction, and everything
 * that would break it is rolled back by the same thing that noticed. Asked here as well, this
 * would be a second copy of the rule, and the day the two disagreed the wrong one would win.
 */
async function orTheLastOwner(change: () => Promise<Moved>): Promise<Moved> {
  try {
    return await change()
  } catch (trouble: unknown) {
    if ((trouble as { constraint?: string }).constraint === KEEPS_AN_OWNER) {
      return { kind: 'the-last-owner' }
    }

    throw trouble
  }
}

/**
 * What is still theirs here, shown before anybody is removed.
 *
 * This is the whole shape of taking somebody out: not a button, a list. Nothing here is stopped
 * or moved automatically — Linear does not reassign a removed member's open issues, and Devin
 * lets a running session run to its natural end. Both are the same judgement this codebase
 * already makes about a failed turn: whether it matters is a person's to say.
 *
 * Read, never stored. The day a stored copy disagreed with the tables, the list would quietly
 * stop being what somebody is actually about to leave behind.
 */
export type Held = {
  readonly working: readonly {
    readonly conversationId: string
    readonly goal: string
    readonly state: string
    readonly machineName: string
  }[]
  readonly machines: readonly {
    readonly id: string
    readonly name: string
    readonly inUse: number
  }[]
}

/**
 * That the conversation being handed over is in the Space the request named.
 *
 * The path says which Space; the body says which piece of work. Without this the two are only
 * checked separately — the person is here, the id exists — and an owner of one Space who has seen
 * an id from another can move that other Space's work. Everything about the answer would look
 * right: the caller is an owner, the target is a member, one row changed.
 */
function inThisSpace(spaceId: string, conversationId: string): Expression<SqlBool> {
  const eb = expressionBuilder<DB>()

  return eb.exists(
    eb
      .selectFrom('conversations')
      .select('conversations.id')
      .where('conversations.id', '=', conversationId)
      .where('conversations.space_id', '=', spaceId),
  )
}

/**
 * That the person being handed something is still in the Space it is in.
 *
 * A condition rather than a read, so it is checked in the statement that writes. Asked first and
 * written second, "hand it over" is a way to move a thing out of the Space it belongs to, into
 * the hands of somebody who cannot reach it — and nothing downstream would ever question it.
 */
function stillAMember(spaceId: string, userId: string): Expression<SqlBool> {
  // Its own builder rather than the outer query's: nothing in here refers to the table being
  // written, so it is the same condition whichever one that is.
  const eb = expressionBuilder<DB>()

  return eb.exists(
    eb
      .selectFrom('memberships')
      .select('memberships.user_id')
      .where('memberships.space_id', '=', spaceId)
      .where('memberships.user_id', '=', userId)
      .where('memberships.revoked_at', 'is', null),
  )
}

/**
 * What happened to a handover: it moved, or the person it was aimed at is not here.
 *
 * Not "no such thing" — the thing is on the screen the request came from. What can be wrong is
 * who it was aimed at, and that has one recovery: pick somebody else.
 */
export type Handed = { kind: 'moved' } | { kind: 'not-a-member' }

/**
 * Hands one piece of work to somebody else in this Space.
 *
 * One column, because the Inbox reads that column: whose it is and who is told about it are the
 * same fact, so there is nothing to keep in step.
 *
 * The new owner has to be a member here, checked in the same statement that writes rather than
 * before it — otherwise "transfer" is a way to move a piece of work out of the Space it is in,
 * and nothing downstream would ever question it.
 */
export async function handWorkTo(
  db: Database,
  moving: { readonly spaceId: string; readonly conversationId: string; readonly userId: string },
): Promise<Handed> {
  const moved = await db
    .updateTable('tasks')
    .set({ owner_user_id: moving.userId })
    .where('conversation_id', '=', moving.conversationId)
    .where('ended_at', 'is', null)
    .where(inThisSpace(moving.spaceId, moving.conversationId))
    .where(stillAMember(moving.spaceId, moving.userId))
    .executeTakeFirst()

  return Number(moved.numUpdatedRows) === 0 ? { kind: 'not-a-member' } : { kind: 'moved' }
}

/**
 * Hands one machine to somebody else in this Space.
 *
 * The same shape and the same reason, one table along. Since `20260909` the row may move: who
 * approved a machine and whose it is are two questions, and only the first is history.
 */
export async function handMachineTo(
  db: Database,
  moving: { readonly spaceId: string; readonly machineId: string; readonly userId: string },
): Promise<Handed> {
  const moved = await db
    .updateTable('machines')
    .set({ owner_user_id: moving.userId })
    .where('id', '=', moving.machineId)
    .where('removed_at', 'is', null)
    .where(reachableFrom(moving.spaceId))
    .where(stillAMember(moving.spaceId, moving.userId))
    .executeTakeFirst()

  return Number(moved.numUpdatedRows) === 0 ? { kind: 'not-a-member' } : { kind: 'moved' }
}

export async function whatTheyHold(
  db: Database,
  who: { readonly spaceId: string; readonly userId: string },
): Promise<Held> {
  const working = await db
    .selectFrom('tasks')
    .innerJoin('conversations', 'conversations.id', 'tasks.conversation_id')
    .innerJoin('machines', 'machines.id', 'conversations.machine_id')
    .select([
      'tasks.conversation_id as conversationId',
      'tasks.goal as goal',
      'tasks.state as state',
      'machines.name as machineName',
    ])
    .where('tasks.owner_user_id', '=', who.userId)
    .where('tasks.ended_at', 'is', null)
    .where('conversations.space_id', '=', who.spaceId)
    .orderBy('tasks.created_at')
    .execute()

  const machines = await db
    .selectFrom('machines')
    .select((eb) => [
      'machines.id as id',
      'machines.name as name',
      // How many conversations are on it that have not finished — which is what "somebody else is
      // using this" means. A count rather than a flag: one is a nuisance, six is a decision.
      eb
        .selectFrom('conversations')
        .innerJoin('tasks', 'tasks.conversation_id', 'conversations.id')
        .select((count) => count.fn.countAll<number>().as('open'))
        .whereRef('conversations.machine_id', '=', 'machines.id')
        .where('tasks.ended_at', 'is', null)
        .as('inUse'),
    ])
    .where('machines.owner_user_id', '=', who.userId)
    .where('machines.removed_at', 'is', null)
    .orderBy('machines.created_at')
    .execute()

  return { working, machines: machines.map((one) => ({ ...one, inUse: Number(one.inUse ?? 0) })) }
}
