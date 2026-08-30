/**
 * Somebody's machines: what one reports, where it can be reached from, and taking one away.
 *
 * How one comes into existence is `enrolment.ts` — the row that decides is the enrolment, and the
 * machine is what it turns into.
 *
 * Locks, in the order every path here takes them:
 *   1. the `machines` row
 *   2. the `agents` rows it reported
 */

import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely'
import type { DB } from '../../generated/db.ts'
import type { AgentKind, FoundAgent } from '../machine/agent-kind.ts'
import { AT_ONCE_BY_DEFAULT } from '../machine/at-once.ts'
import type { Whereabouts } from '../machine/presence.ts'
import type { Database, Tx } from './connection.ts'

/**
 * An agent on a machine, as the database has it.
 *
 * `models` comes back as whatever is in the column. It is left unread here on purpose: a list
 * written by a different build of this program is exactly the case where a shape can be wrong, and
 * the layer that has to answer for it is the one putting it on the wire.
 */
export type Installed = {
  readonly kind: AgentKind
  readonly name: string | null
  readonly atOnce: number
  readonly version: string
  readonly models: unknown
}

/**
 * How many this agent may run at the same time: what its owner decided, or the default.
 *
 * A fragment rather than a query, because it is asked in two shapes that have to agree — beside
 * every agent in a Space, and inside the statement that claims a turn. Written twice, a page
 * would eventually show a number that the claim does not honour, and neither copy would look
 * wrong on its own.
 *
 * No row means nobody has decided anything about this agent, which is not the same as a decision
 * to allow the default — but it is what they get, and it is what the column would have given them
 * had a row been written for some other reason.
 */
export function atOnceFor(machineId: Expression<string>, kind: Expression<string>) {
  return sql<number>`coalesce((
    select settings.at_once from agent_settings settings
     where settings.machine_id = ${machineId} and settings.kind = ${kind}
  ), ${AT_ONCE_BY_DEFAULT}::int)`
}

/** Whose machine a credential is, if it is still one. */
export async function machineHolding(db: Database, tokenHash: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('machines')
    .select('id')
    .where('token_hash', '=', tokenHash)
    .where('removed_at', 'is', null)
    .executeTakeFirst()

  return row?.id
}

/**
 * Records a check-in and replaces what the machine says it has.
 *
 * Replaces rather than merges: the report is the whole truth about that machine as of now, so an
 * agent that was uninstalled is one that is missing from the report. Merging would leave it listed
 * forever, and somebody would send it work that cannot run.
 *
 * Its own version is part of that truth. A build too old to report one leaves the column null,
 * which is why nothing here fills it in.
 */
export async function checkIn(
  db: Database,
  machineId: string,
  reported: {
    /** Which build of the CLI is reporting, or nothing when it is too old to say. */
    readonly version: string | undefined
    /**
     * The directory that machine was connected in, or nothing when it is too old to say.
     *
     * Not where anything runs — where a person was standing when they connected it, which is the
     * one directory a screen can offer as "my project" without anybody typing a path.
     */
    readonly connectedIn: string | undefined
    readonly found: readonly FoundAgent[]
  },
): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    // Still ours, decided here rather than trusted from the check the middleware made before this
    // transaction opened. Somebody can remove a machine in between, and a removal that only takes
    // effect on the next request is a machine that stays alive for one more of them.
    const still = await tx
      .updateTable('machines')
      .set({
        last_seen_at: sql<Date>`clock_timestamp()`,
        left_at: null,
        // Written every time rather than only when it changes: a machine that stopped saying which
        // build it is has stopped knowing, and the honest record of that is null. Its directory
        // goes the same way, and for a second reason — a service can be moved, and the answer has
        // to be about the process running now.
        version: reported.version ?? null,
        connected_in: reported.connectedIn ?? null,
      })
      .where('id', '=', machineId)
      .where('removed_at', 'is', null)
      .returning('id')
      .executeTakeFirst()

    if (still === undefined) return false

    await replaceAgents(tx, machineId, reported.found)
    return true
  })
}

async function replaceAgents(
  tx: Tx,
  machineId: string,
  found: readonly FoundAgent[],
): Promise<void> {
  const kinds = found.map((agent) => agent.kind)

  const gone = tx.deleteFrom('agents').where('machine_id', '=', machineId)
  await (kinds.length === 0 ? gone : gone.where('kind', 'not in', kinds)).execute()

  if (found.length === 0) return

  await tx
    .insertInto('agents')
    .values(
      found.map((agent) => ({
        machine_id: machineId,
        kind: agent.kind,
        version: agent.version,
        models: agent.models === undefined ? null : JSON.stringify(agent.models),
      })),
    )
    .onConflict((clash) =>
      clash.columns(['machine_id', 'kind']).doUpdateSet({
        version: (eb) => eb.ref('excluded.version'),
        found_at: sql<Date>`clock_timestamp()`,
        // Three cases, decided here rather than by whoever wrote the report: what was reported
        // wins; a report that says nothing about a version we already knew leaves what we have;
        // and a version we have not seen before with nothing said about it clears the list, because
        // what the last version offered is not what this one offers.
        models: sql`case
          when excluded.models is not null then excluded.models
          when agents.version = excluded.version then agents.models
          else null
        end`,
      }),
    )
    .execute()
}

/**
 * Marks a machine as having left on purpose.
 *
 * Without this a page has to wait out the silence before believing it, and the common case — a
 * laptop being closed, a service being stopped — would look exactly like a crash.
 */
export async function sayGoodbye(db: Database, machineId: string): Promise<void> {
  await db
    .updateTable('machines')
    .set({ left_at: sql<Date>`clock_timestamp()` })
    .where('id', '=', machineId)
    .execute()
}

/**
 * A machine as a Space screen shows it. Whether it is here is worked out from `whereabouts`.
 *
 * Not `Attached`: that word is the door a machine's credential opens, and one name for the holder
 * of a credential and for a row on a screen is one of them being read as the other.
 */
type Machine = {
  readonly id: string
  readonly name: string
  /** Which build of the CLI it is running, or nothing when it has never said. */
  readonly version: string | undefined
  /**
   * The directory it was connected in, or null when it has never said.
   *
   * Not where anything runs — where a person was standing when they connected it. It is the one
   * directory a screen can offer as "my project" without anybody typing a path.
   */
  readonly connectedIn: string | null
  /**
   * Whose it is.
   *
   * Carried because a Space with two people in it has two people's laptops in it, and what runs
   * on one of them runs in that person's files. A name on its own does not say that.
   */
  readonly ownerName: string
  readonly ownerUserId: string
  readonly whereabouts: Whereabouts
  readonly agents: readonly Installed[]
}

/**
 * What was there, and the moment it was true.
 *
 * `asOf` is the database's clock, not this process's, and that is the whole reason it is carried
 * out of here. `last_seen_at` is written by `clock_timestamp()`; measuring the silence since then
 * against a `new Date()` in the app would be two clocks deciding one fact. A few seconds of drift
 * either way and every machine in a Space reads as gone, or as here forever — and nothing would
 * raise an error, the page would simply lie.
 */
export type Seen = {
  readonly asOf: Date
  readonly machines: readonly Machine[]
}

/**
 * Whether a machine can be reached from this Space: its owner is a member here.
 *
 * A condition and not a join, so that a read taking `for update` locks the machine and nothing
 * else. Joined, `for update` would lock the membership row too — and then opening a conversation
 * would queue behind anything touching who is in what.
 */
/**
 * The conversation a machine is allowed to write into, locked, or nothing.
 *
 * Two paths need this and they must never disagree: a machine adding a line to a transcript, and
 * a machine reporting on the piece of work it is running. **Both write.** What is happening right
 * now does not — it has {@link stillItsToSpeakOf}, and the difference is the whole point of the
 * cost this one accepts below. Both are told by the middleware that
 * the credential is good — and both open a transaction afterwards, so both have to ask again
 * inside it. A machine somebody removed in between must not get one more write.
 *
 * The join is what makes the removal check mean anything. Read without it, `removeMachine` can
 * commit between this and the write and the line lands anyway; with it, `for update` holds the
 * machine's row too. It costs the writes on one machine being serialized against each other — a
 * row lock held for one short transaction, against a few lines a second — which is worth what it
 * buys.
 *
 * Takes the transaction, not the pool: read outside the one that writes, the answer is already
 * stale by the time it is used.
 */
export async function stillItsToWriteOn(
  tx: Tx,
  on: { readonly conversationId: string; readonly machineId: string },
): Promise<string | undefined> {
  const conversation = await tx
    .selectFrom('conversations')
    .innerJoin('machines', 'machines.id', 'conversations.machine_id')
    .select('conversations.id')
    .where('conversations.id', '=', on.conversationId)
    .where('conversations.machine_id', '=', on.machineId)
    .where('machines.removed_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()

  return conversation?.id
}

/**
 * Whether this machine may still be heard about this conversation. No lock, no transaction.
 *
 * The same question as {@link stillItsToWriteOn} and deliberately not the same answer, because
 * what asks it is different in kind. That one guards a write and pays a row lock on two tables to
 * do it; this one guards a moment that is kept nowhere and is gone a second later.
 *
 * It used to call that one, and the cost was not the lock itself — it was the frequency. A turn
 * streams what a command is printing in three-kilobyte pieces, so every piece opened a
 * transaction and took `for update` on the conversation *and* on the machine, to then write
 * nothing at all. Three conversations running on one laptop serialized all of their output on
 * that machine's single row, against a row the machine itself writes on every check-in.
 *
 * What is lost by not locking is that a machine removed in this exact millisecond may have one
 * more moment shown to somebody already watching. It is shown and forgotten; the transcript is
 * untouched, and the browser is asking the same question of its own membership before every frame
 * it is handed — see `server/live-api.ts`.
 */
export async function stillItsToSpeakOf(
  db: Database,
  on: { readonly conversationId: string; readonly machineId: string },
): Promise<boolean> {
  const conversation = await db
    .selectFrom('conversations')
    .select('conversations.id')
    .where('conversations.id', '=', on.conversationId)
    .where('conversations.machine_id', '=', on.machineId)
    // `exists` rather than a join, so there is no second table here at all. Joined, this would be
    // the shape `review.md` 7 warns about even without `for update` on it today.
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('machines')
          .select('machines.id')
          .whereRef('machines.id', '=', 'conversations.machine_id')
          .where('machines.removed_at', 'is', null),
      ),
    )
    .executeTakeFirst()

  return conversation !== undefined
}

export function reachableFrom(spaceId: string) {
  return (eb: ExpressionBuilder<DB, 'machines'>): Expression<SqlBool> =>
    eb.exists(
      eb
        .selectFrom('memberships')
        .select('memberships.user_id')
        .whereRef('memberships.user_id', '=', 'machines.owner_user_id')
        .where('memberships.space_id', '=', spaceId)
        // Somebody who was removed takes their machines with them, at the moment they are
        // removed. Left out here and nowhere else, a Space would go on reaching a laptop that
        // belongs to somebody who is no longer in it.
        .where('memberships.revoked_at', 'is', null),
    )
}

/**
 * Every machine a Space can reach.
 *
 * Not "the machines in this Space" — a machine is not in a Space. It is somebody's, and it can be
 * reached from wherever they are a member. Joined rather than stored: a stored list would be a
 * second copy of who is in what, and the day it disagreed nobody would find out.
 */
export async function machinesIn(db: Database, spaceId: string): Promise<Seen> {
  // One transaction, so `now()` and every row it is compared against are the same instant.
  return db.transaction().execute(async (tx) => attachedIn(tx, spaceId))
}

async function attachedIn(tx: Tx, spaceId: string): Promise<Seen> {
  const { asOf } = await tx.selectNoFrom(sql<Date>`now()`.as('asOf')).executeTakeFirstOrThrow()

  const rows = await tx
    .selectFrom('machines')
    .innerJoin('users', 'users.id', 'machines.owner_user_id')
    .select([
      'machines.id',
      'machines.name',
      'machines.version',
      'machines.connected_in as connectedIn',
      'machines.last_seen_at as lastSeenAt',
      'machines.left_at as leftAt',
      // Whose it is, because in a Space with two people in it a name is not enough: one of these
      // is somebody else's laptop, and what runs on it runs in their files.
      'users.display_name as ownerName',
      'machines.owner_user_id as ownerUserId',
    ])
    .where('machines.removed_at', 'is', null)
    .where(reachableFrom(spaceId))
    .orderBy('machines.created_at')
    .execute()

  if (rows.length === 0) return { asOf, machines: [] }

  const found = await installedOn(
    tx,
    rows.map((row) => row.id),
  )

  return {
    asOf,
    machines: rows.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version ?? undefined,
      ownerName: row.ownerName,
      ownerUserId: row.ownerUserId,
      connectedIn: row.connectedIn,
      whereabouts: { lastSeenAt: row.lastSeenAt, leftAt: row.leftAt },
      agents: installationsOn(row.id, found),
    })),
  }
}

type NamedInstallation = Installed & { readonly machineId: string }

function installationsOn(
  machineId: string,
  found: readonly NamedInstallation[],
): readonly Installed[] {
  return found.flatMap((agent) => {
    if (agent.machineId !== machineId) return []
    return [
      {
        kind: agent.kind,
        name: agent.name,
        atOnce: agent.atOnce,
        version: agent.version,
        models: agent.models,
      },
    ]
  })
}

async function installedOn(
  tx: Tx,
  machineIds: readonly string[],
): Promise<readonly NamedInstallation[]> {
  return (
    tx
      .selectFrom('agents')
      .leftJoin('agent_settings', (join) =>
        join
          .onRef('agent_settings.machine_id', '=', 'agents.machine_id')
          .onRef('agent_settings.kind', '=', 'agents.kind'),
      )
      .select([
        'agents.machine_id as machineId',
        'agents.kind',
        'agent_settings.name',
        atOnceFor(sql.ref('agents.machine_id'), sql.ref('agents.kind')).as('atOnce'),
        'agents.version',
        'agents.models',
      ])
      // The schema and AgentKind are checked against each other in a database test. Narrowing from
      // that boundary keeps the query honest without scattering casts through every caller.
      .$narrowType<{ kind: AgentKind }>()
      .where('agents.machine_id', 'in', machineIds)
      .orderBy('agents.kind')
      .execute()
  )
}

/**
 * What an owner has decided about one agent on one of their machines.
 *
 * Kept outside the machine's discovery report, which is replaced whole on every check-in: an
 * absent report can remove the installed row, and it must not be able to remove the decisions
 * that should come back with it.
 *
 * A patch. Anything left out is left alone — so setting how many at a time does not have to
 * restate the name, and there is no read-then-write in a caller for the two to disagree across.
 */
export async function setAgentSettings(
  db: Database,
  deciding: {
    readonly machine: string
    readonly owner: string
    readonly kind: AgentKind
    /** Null takes the name off, which is what putting it back to its kind's name means. */
    readonly name?: string | null | undefined
    readonly atOnce?: number | undefined
  },
): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    const machine = await tx
      .selectFrom('machines')
      .select('id')
      .where('id', '=', deciding.machine)
      .where('owner_user_id', '=', deciding.owner)
      .where('removed_at', 'is', null)
      .forUpdate()
      .executeTakeFirst()

    if (machine === undefined) return false

    const installed = await tx
      .selectFrom('agents')
      .select('kind')
      .where('machine_id', '=', machine.id)
      .where('kind', '=', deciding.kind)
      .forUpdate()
      .executeTakeFirst()

    if (installed === undefined) return false

    // Written rather than deleted when a name comes off: the row may be carrying how many at a
    // time as well, and taking a name off is not a decision to forget that one too.
    const decided: { name?: string | null; at_once?: number } = {}
    if (deciding.name !== undefined) decided.name = deciding.name
    if (deciding.atOnce !== undefined) decided.at_once = deciding.atOnce

    await tx
      .insertInto('agent_settings')
      .values({ machine_id: deciding.machine, kind: deciding.kind, ...decided })
      .onConflict((clash) =>
        clash.columns(['machine_id', 'kind']).doUpdateSet({
          ...decided,
          decided_at: sql<Date>`clock_timestamp()`,
        }),
      )
      .execute()

    return true
  })
}

/**
 * Takes a machine out of its Space. Its credential stops working on the next call it makes.
 *
 * The two ids are named rather than ordered: both are opaque, so a caller that swapped them would
 * compile, remove nothing, and be told the machine does not exist.
 */
export async function removeMachine(
  db: Database,
  which: { readonly machine: string; readonly owner: string },
): Promise<boolean> {
  const removed = await db
    .updateTable('machines')
    .set({ removed_at: sql<Date>`clock_timestamp()` })
    .where('id', '=', which.machine)
    // Named by whose it is, so an id belonging to somebody else removes nothing rather than
    // disconnecting their laptop. Only its owner can, which is the point of it being theirs.
    .where('owner_user_id', '=', which.owner)
    .where('removed_at', 'is', null)
    .returning('id')
    .executeTakeFirst()

  return removed !== undefined
}
