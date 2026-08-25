/**
 * The machines in a Space: turning an approved enrolment into one, and what one reports.
 *
 * Locks, in the order every path here takes them:
 *   1. the `enrolments` row, by a conditional update only a first collection matches
 *   2. the `machines` row it becomes
 *   3. the `agents` rows it reported
 */

import { sql } from 'kysely'
import type { AgentKind, FoundAgent } from '../machine/agent-kind.ts'
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
      .returning(['id', 'space_id', 'machine_name'])
      // `enrolments_approved_into_a_space` says an approved row has one, and only approved rows
      // reach here. The column is nullable because an unapproved enrolment has no Space yet.
      .$narrowType<{ space_id: string }>()
      .executeTakeFirst()

    if (won === undefined) return whyNot(tx, collecting.secretHash)

    const machine = await tx
      .insertInto('machines')
      .values({
        space_id: won.space_id,
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
 * Why the collection did not happen. Only reached when the update matched nothing.
 *
 * The order is what the reader needs most, not the order the columns are in: being told somebody
 * else already collected this beats being told it also happened to run out afterwards.
 */
async function whyNot(tx: Tx, secretHash: string): Promise<Enrolment> {
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
 */
export async function checkIn(
  db: Database,
  machineId: string,
  found: readonly FoundAgent[],
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable('machines')
      .set({ last_seen_at: sql<Date>`clock_timestamp()`, left_at: null })
      .where('id', '=', machineId)
      .execute()

    await replaceAgents(tx, machineId, found)
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
      found.map((agent) => ({ machine_id: machineId, kind: agent.kind, version: agent.version })),
    )
    .onConflict((clash) =>
      clash.columns(['machine_id', 'kind']).doUpdateSet({
        version: (eb) => eb.ref('excluded.version'),
        found_at: sql<Date>`clock_timestamp()`,
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
  readonly whereabouts: Whereabouts
  readonly agents: readonly FoundAgent[]
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

export async function machinesIn(db: Database, spaceId: string): Promise<Seen> {
  // One transaction, so `now()` and every row it is compared against are the same instant.
  return db.transaction().execute(async (tx) => attachedIn(tx, spaceId))
}

async function attachedIn(tx: Tx, spaceId: string): Promise<Seen> {
  const { asOf } = await tx.selectNoFrom(sql<Date>`now()`.as('asOf')).executeTakeFirstOrThrow()

  const rows = await tx
    .selectFrom('machines')
    .select(['id', 'name', 'last_seen_at as lastSeenAt', 'left_at as leftAt'])
    .where('space_id', '=', spaceId)
    .where('removed_at', 'is', null)
    .orderBy('created_at')
    .execute()

  if (rows.length === 0) return { asOf, machines: [] }

  const found = await tx
    .selectFrom('agents')
    .select(['machine_id as machineId', 'kind', 'version'])
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
      whereabouts: { lastSeenAt: row.lastSeenAt, leftAt: row.leftAt },
      agents: found
        .filter((agent) => agent.machineId === row.id)
        .map((agent) => ({ kind: agent.kind, version: agent.version })),
    })),
  }
}

/** Takes a machine out of its Space. Its credential stops working on the next call it makes. */
export async function removeMachine(
  db: Database,
  machineId: string,
  spaceId: string,
): Promise<boolean> {
  const removed = await db
    .updateTable('machines')
    .set({ removed_at: sql<Date>`clock_timestamp()` })
    .where('id', '=', machineId)
    // Named by the Space it is in, so an id from another Space removes nothing rather than
    // removing somebody else's machine.
    .where('space_id', '=', spaceId)
    .where('removed_at', 'is', null)
    .returning('id')
    .executeTakeFirst()

  return removed !== undefined
}
