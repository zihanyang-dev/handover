/**
 * Somebody's machines: turning an approved enrolment into one, and what one reports.
 *
 * Locks, in the order every path here takes them:
 *   1. the `enrolments` row, by a conditional update only a first collection matches
 *   2. the `machines` row it becomes
 *   3. the `agents` rows it reported
 */

import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely'
import type { DB } from '../../generated/db.ts'
import type { AgentKind, FoundAgent, Installed } from '../machine/agent-kind.ts'
import type { Enrolment } from '../machine/enrolment.ts'
import type { Whereabouts } from '../machine/presence.ts'
import type { Database, Tx } from './connection.ts'

export type Collected = { readonly kind: 'granted'; readonly machineId: string } | Enrolment

export type Collecting = {
  readonly secretHash: string
  /** The credential this machine will hold afterwards. The token itself never comes here. */
  readonly tokenHash: string
  /** What the machine calls itself. Used only when nobody named it at approval. */
  readonly machineName: string
}

/**
 * Turns an approved enrolment into a machine, or says why it cannot.
 *
 * The `where` is the whole guard: two machines racing on one single-use key both run this update
 * and only one matches. Reading first and deciding in TypeScript would let both in, and the
 * second would be a machine nobody meant to admit.
 */
export async function collectEnrolment(db: Database, collecting: Collecting): Promise<Collected> {
  return db.transaction().execute(async (tx) => {
    const won = await tx
      .updateTable('enrolments')
      .set({ claimed_at: sql<Date>`clock_timestamp()` })
      .where('secret_hash', '=', collecting.secretHash)
      .where('approved_at', 'is not', null)
      .where('refused_at', 'is', null)
      .where('claimed_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .returning(['id', 'approved_by', 'machine_name'])
      // `enrolments_approved_together` says an approved row names who approved it, and only
      // approved rows reach here. The column is nullable because nobody has said yes yet.
      .$narrowType<{ approved_by: string }>()
      .executeTakeFirst()

    if (won === undefined) return whyNot(tx, collecting)

    const machine = await tx
      .insertInto('machines')
      .values({
        // Whoever said yes owns it. Not the Space they were looking at when they did: a laptop
        // belongs to a person, and that person is in as many Spaces as they are in.
        owner_user_id: won.approved_by,
        // What was approved wins: somebody looked at a name and said yes to it, and a machine
        // that arrived calling itself something else is not the one they agreed to.
        name: won.machine_name ?? collecting.machineName,
        token_hash: collecting.tokenHash,
        enrolled_from: won.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    return { kind: 'granted', machineId: machine.id }
  })
}

/**
 * Why the collection did not happen, or that it already did.
 *
 * A machine that collected and never heard the answer asks again with the same secret and the same
 * token. That is not somebody else taking its place — it is the same machine, and the answer it
 * missed is still the true one. Anything else with a spent secret really is somebody else.
 *
 * The rest is ordered by what the reader needs most, not by the order the columns are in: being
 * told somebody else already collected this beats being told it also happened to run out.
 */
async function whyNot(tx: Tx, collecting: Collecting): Promise<Collected> {
  const secretHash = collecting.secretHash
  const already = await tx
    .selectFrom('enrolments')
    .innerJoin('machines', 'machines.enrolled_from', 'enrolments.id')
    .select('machines.id')
    .where('enrolments.secret_hash', '=', secretHash)
    .where('machines.token_hash', '=', collecting.tokenHash)
    .where('machines.removed_at', 'is', null)
    .executeTakeFirst()

  if (already !== undefined) return { kind: 'granted', machineId: already.id }

  const row = await tx
    .selectFrom('enrolments')
    // Whether it ran out is decided by the database's clock, like every other deadline here.
    // Comparing against this process's clock would make the answer depend on which host replied.
    .select([
      'approved_at',
      'refused_at',
      'claimed_at',
      sql<boolean>`expires_at <= now()`.as('isOver'),
    ])
    .where('secret_hash', '=', secretHash)
    .executeTakeFirst()

  if (row === undefined) return { kind: 'no-enrolment' }
  if (row.claimed_at !== null) return { kind: 'spent' }
  if (row.refused_at !== null) return { kind: 'refused' }
  if (row.isOver) return { kind: 'expired' }

  return { kind: 'waiting' }
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
        // build it is has stopped knowing, and the honest record of that is null.
        version: reported.version ?? null,
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
export type Machine = {
  readonly id: string
  readonly name: string
  /** Which build of the CLI it is running, or nothing when it has never said. */
  readonly version: string | undefined
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

  const found = await tx
    .selectFrom('agents')
    .select(['machine_id as machineId', 'kind', 'version', 'models'])
    // `agents_kind_is_one_we_know` is the list this type is made of, and there is a test that says
    // the two are the same list. Stated here rather than cast below, like every other invariant
    // in this file that the schema already guarantees.
    .$narrowType<{ kind: AgentKind }>()
    .where(
      'machine_id',
      'in',
      rows.map((row) => row.id),
    )
    .orderBy('kind')
    .execute()

  return {
    asOf,
    machines: rows.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version ?? undefined,
      ownerName: row.ownerName,
      ownerUserId: row.ownerUserId,
      whereabouts: { lastSeenAt: row.lastSeenAt, leftAt: row.leftAt },
      agents: found
        .filter((agent) => agent.machineId === row.id)
        .map((agent) => ({ kind: agent.kind, version: agent.version, models: agent.models })),
    })),
  }
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
