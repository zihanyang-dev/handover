/**
 * One attempt to connect a machine to somebody: opening it, answering it, and collecting it.
 *
 * Both ways in are this table. A person at a browser opens one that is already approved and pastes
 * its secret onto a server; a machine opens one that is not and waits for somebody to say yes. An
 * auth key is not a second mechanism — it is an enrolment that arrived approved.
 *
 * Locks, in the order every path here takes them:
 *   1. the `enrolments` row, by a conditional update that only a first answer matches
 *   2. the `machines` row it turns into
 *   3. the `memberships` row when an approved Space was named
 *   4. the `space_machines` row that approval may restore
 *
 * No advisory lock. Every transition here is one `update ... where <still open>`: whoever gets
 * there second updates nothing and is told what already happened. A lock would only move that
 * decision out of SQL, where it is enforced, into TypeScript, where it is remembered.
 */

import { expressionBuilder, sql, type UpdateObject } from 'kysely'
import type { DB } from '../../generated/db.ts'
import { LIFETIME_MINUTES, type Enrolment } from '../machine/enrolment.ts'
import type { Whereabouts } from '../machine/presence.ts'
import type { UserCode } from '../machine/user-code.ts'
import type { Database, Tx } from './connection.ts'

/**
 * The two ways an enrolment begins, as two shapes rather than one with holes in it.
 *
 * Written as one shape with four optional fields, the illegal combinations were all expressible:
 * a key with a user code nobody will ever read, a machine asking that names its own Space, an
 * enrolment approved by somebody and waiting for an answer at once. Which of those are possible is
 * the whole of what this type has to say.
 */
export type OpeningEnrolment = MachineAsking | KeyMade

/** A machine that showed a code and is waiting for a person to answer it. */
export type MachineAsking = {
  readonly kind: 'asking'
  readonly secretHash: string
  /** What the machine calls itself, which is all anybody knows about it yet. */
  readonly machineName: string
  /** What somebody reads off one screen and types into another. */
  readonly userCode: UserCode
}

/**
 * A key somebody made for themselves, which is an enrolment that arrives approved.
 *
 * No code, because nobody will read one and a code nobody reads can only leak. No machine name,
 * because it is made before anybody knows which machine will use it. Only who made it, because
 * making one *was* the approving — and what they were agreeing to is that the machine is theirs.
 */
type KeyMade = {
  readonly kind: 'key'
  readonly secretHash: string
  readonly approvedBy: string
  readonly approvedSpaceId?: string
}

export type Opened = {
  readonly id: string
  readonly expiresAt: Date
}

export async function openEnrolment(db: Database, opening: OpeningEnrolment): Promise<Opened> {
  const row = await db
    .insertInto('enrolments')
    .values({
      secret_hash: opening.secretHash,
      expires_at: sql`now() + make_interval(mins => ${LIFETIME_MINUTES})`,
      ...(opening.kind === 'asking'
        ? {
            machine_name: opening.machineName,
            user_code: opening.userCode,
            approved_by: null,
            approved_at: null,
          }
        : {
            machine_name: null,
            user_code: null,
            approved_by: opening.approvedBy,
            approved_at: sql<Date>`clock_timestamp()`,
            approved_space_id: opening.approvedSpaceId ?? null,
          }),
    })
    .returning(['id', 'expires_at'])
    .executeTakeFirstOrThrow()

  return { id: row.id, expiresAt: row.expires_at }
}

/**
 * What the approval page shows: which machine is asking.
 *
 * Not which Space — that is the question the page asks, not one it answers.
 */
export type Waiting = {
  readonly machineName: string
  readonly expiresAt: Date
}

/**
 * An enrolment nobody has answered yet, and that has not run out.
 *
 * Said once because it is asked twice, and the two must agree: once to show a person what they
 * are about to say yes to, and once as the guard on the update that says it. Tightened in one and
 * not the other, somebody would be shown a machine they are then told is not there.
 */
function stillWaiting(userCode: UserCode) {
  const eb = expressionBuilder<DB, 'enrolments'>()

  return eb.and([
    eb('user_code', '=', userCode),
    eb('approved_at', 'is', null),
    eb('refused_at', 'is', null),
    eb('expires_at', '>', sql<Date>`now()`),
  ])
}

export async function enrolmentWaiting(
  db: Database,
  userCode: UserCode,
): Promise<Waiting | undefined> {
  return (
    db
      .selectFrom('enrolments')
      .select(['machine_name as machineName', 'expires_at as expiresAt'])
      // Only the code path has a `user_code`, and only that path records a name — so a row found
      // here always has one, and nothing downstream has to wonder what to show.
      .$narrowType<{ machineName: string }>()
      .where(stillWaiting(userCode))
      .executeTakeFirst()
  )
}

type ExistingMachine = {
  readonly id: string
  readonly createdAt: Date
  readonly whereabouts: Whereabouts
}

type ExistingMachines = { readonly asOf: Date; readonly machines: readonly ExistingMachine[] }

/** Same-named identities the approving person may explicitly reconnect — never an automatic match. */
export async function existingMachinesFor(
  db: Database,
  which: { readonly ownerUserId: string; readonly machineName: string },
): Promise<ExistingMachines> {
  return db.transaction().execute(async (tx) => await sameNamedMachinesAsOf(tx, which))
}

async function sameNamedMachinesAsOf(
  tx: Tx,
  which: { readonly ownerUserId: string; readonly machineName: string },
): Promise<ExistingMachines> {
  const { asOf } = await tx.selectNoFrom(sql<Date>`now()`.as('asOf')).executeTakeFirstOrThrow()
  const machineRows = await tx
    .selectFrom('machines')
    .select(['id', 'created_at as createdAt', 'last_seen_at as lastSeenAt', 'left_at as leftAt'])
    .where('owner_user_id', '=', which.ownerUserId)
    .where('name', '=', which.machineName)
    .where('removed_at', 'is', null)
    .orderBy('created_at')
    .execute()

  return {
    asOf,
    machines: machineRows.map((machine) => ({
      id: machine.id,
      createdAt: machine.createdAt,
      whereabouts: { lastSeenAt: machine.lastSeenAt, leftAt: machine.leftAt },
    })),
  }
}

export type Answered =
  | { readonly kind: 'answered' }
  /** The chosen identity is not this person's live, same-named machine. */
  | { readonly kind: 'cannot-replace' }
  /** Somebody already answered, it ran out, or there was never one by that code. */
  | { readonly kind: 'not-waiting' }

class CannotReplaceMachine extends Error {}

const ONE_PENDING_REPLACEMENT = 'enrolments_one_pending_replacement'

/**
 * Says yes on behalf of a person, if nobody has answered yet.
 *
 * The guard is the `where`, not a read before it: two people answering at once both run this, and
 * the second updates nothing. Reading first and deciding in TypeScript would let both through.
 *
 * The machine never supplies a Space. A browser may carry the Space whose Add machine journey
 * opened the approval page; it is accepted only while the approver is still a member there.
 */
type Approving = {
  readonly userId: string
  readonly replaceMachineId?: string
  readonly approvedSpaceId?: string
}

export async function approveEnrolment(
  db: Database,
  userCode: UserCode,
  by: Approving,
): Promise<Answered> {
  try {
    return await db.transaction().execute(async (tx) => approveWaiting(tx, userCode, by))
  } catch (error) {
    const constraint = (error as { constraint?: string }).constraint
    if (error instanceof CannotReplaceMachine || constraint === ONE_PENDING_REPLACEMENT) {
      return { kind: 'cannot-replace' }
    }
    throw error
  }
}

async function approveWaiting(tx: Tx, userCode: UserCode, by: Approving): Promise<Answered> {
  // The enrolment first, then the optional machine: collect takes the same order. The update is
  // still the race guard — a second answer waits here and then updates nothing.
  const approvedSpaceId = by.approvedSpaceId === undefined ? null : by.approvedSpaceId
  const approval = tx
    .updateTable('enrolments')
    .set({
      approved_by: by.userId,
      approved_at: sql<Date>`clock_timestamp()`,
      approved_space_id: approvedSpaceId,
    })
    .where(stillWaiting(userCode))
  const membership =
    by.approvedSpaceId === undefined
      ? undefined
      : tx
          .selectFrom('memberships')
          .select('user_id')
          .where('space_id', '=', by.approvedSpaceId)
          .where('user_id', '=', by.userId)
          .where('revoked_at', 'is', null)
  const permittedApproval =
    membership === undefined ? approval : approval.where((eb) => eb.exists(membership))

  const changed = await permittedApproval
    .returning(['id', 'machine_name'])
    .$narrowType<{ machine_name: string }>()
    .executeTakeFirst()
  if (changed === undefined) return { kind: 'not-waiting' }
  if (by.replaceMachineId === undefined) return { kind: 'answered' }

  const replacement = await tx
    .selectFrom('machines')
    .select('id')
    .where('id', '=', by.replaceMachineId)
    .where('owner_user_id', '=', by.userId)
    .where('name', '=', changed.machine_name)
    .where('removed_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
  if (replacement === undefined) throw new CannotReplaceMachine()

  await releaseExpiredReplacement(tx, replacement.id)
  await tx
    .updateTable('enrolments')
    .set({ replaces_machine_id: replacement.id })
    .where('id', '=', changed.id)
    .execute()

  return { kind: 'answered' }
}

async function releaseExpiredReplacement(tx: Tx, machineId: string): Promise<void> {
  await tx
    .updateTable('enrolments')
    .set({ replaces_machine_id: null })
    .where('replaces_machine_id', '=', machineId)
    .where('claimed_at', 'is', null)
    .where('expires_at', '<=', sql<Date>`now()`)
    .execute()
}

export async function refuseEnrolment(db: Database, userCode: UserCode): Promise<Answered> {
  return answer(db, userCode, { refused_at: sql<Date>`clock_timestamp()` })
}

/** Typed against the table, so a column name that is not one is a compile error, not a 500. */
type Transition = UpdateObject<DB, 'enrolments'>

async function answer(db: Database, userCode: UserCode, transition: Transition): Promise<Answered> {
  const changed = await db
    .updateTable('enrolments')
    .set(transition)
    .where(stillWaiting(userCode))
    .returning('id')
    .executeTakeFirst()

  return changed === undefined ? { kind: 'not-waiting' } : { kind: 'answered' }
}

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
  return db.transaction().execute(async (tx) => await collectApprovedEnrolment(tx, collecting))
}

async function collectApprovedEnrolment(tx: Tx, collecting: Collecting): Promise<Collected> {
  const won = await claimApprovedEnrolment(tx, collecting.secretHash)
  if (won === undefined) return whyNot(tx, collecting)

  const machine = await grantMachine(tx, won, collecting)
  // The person may have removed the chosen machine after approving but before collection. Do not
  // silently create a duplicate: the terminal must ask again and receive a new decision.
  if (machine === undefined) return { kind: 'no-enrolment' }

  await makeAvailableInApprovedSpace(tx, won, machine.id)
  return { kind: 'granted', machineId: machine.id }
}

type WonEnrolment = {
  readonly id: string
  readonly approved_by: string
  readonly approved_space_id: string | null
  readonly machine_name: string | null
  readonly replaces_machine_id: string | null
}

async function claimApprovedEnrolment(
  tx: Tx,
  secretHash: string,
): Promise<WonEnrolment | undefined> {
  return (
    tx
      .updateTable('enrolments')
      .set({ claimed_at: sql<Date>`clock_timestamp()` })
      .where('secret_hash', '=', secretHash)
      .where('approved_at', 'is not', null)
      .where('refused_at', 'is', null)
      .where('claimed_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .returning(['id', 'approved_by', 'approved_space_id', 'machine_name', 'replaces_machine_id'])
      // `enrolments_approved_together` says an approved row names who approved it, and only approved
      // rows reach here. The column is nullable because nobody has said yes yet.
      .$narrowType<{ approved_by: string }>()
      .executeTakeFirst()
  )
}

async function grantMachine(tx: Tx, won: WonEnrolment, collecting: Collecting) {
  const machineName = won.machine_name === null ? collecting.machineName : won.machine_name
  if (won.replaces_machine_id === null) {
    return await tx
      .insertInto('machines')
      .values({
        owner_user_id: won.approved_by,
        name: machineName,
        token_hash: collecting.tokenHash,
        enrolled_from: won.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  }

  return await tx
    .updateTable('machines')
    .set({
      name: machineName,
      token_hash: collecting.tokenHash,
      enrolled_from: won.id,
      left_at: sql<Date>`clock_timestamp()`,
      version: null,
    })
    .where('id', '=', won.replaces_machine_id)
    .where('owner_user_id', '=', won.approved_by)
    .where('removed_at', 'is', null)
    .returning('id')
    .executeTakeFirst()
}

async function makeAvailableInApprovedSpace(
  tx: Tx,
  won: WonEnrolment,
  machineId: string,
): Promise<void> {
  if (won.approved_space_id === null) return

  const approvedMembership = tx
    .selectFrom('memberships')
    .select([
      sql<string>`${won.approved_space_id}`.as('space_id'),
      sql<string>`${machineId}`.as('machine_id'),
      'memberships.user_id as added_by',
    ])
    .where('memberships.space_id', '=', won.approved_space_id)
    .where('memberships.user_id', '=', won.approved_by)
    .where('memberships.revoked_at', 'is', null)
    // Member removal takes this lock before revoking relationships. Without the same lock,
    // collection can read the old membership and restore a relationship after removal missed it.
    .forUpdate('memberships')

  await tx
    .insertInto('space_machines')
    .columns(['space_id', 'machine_id', 'added_by'])
    .expression(approvedMembership)
    .onConflict((conflict) =>
      conflict.columns(['space_id', 'machine_id']).doUpdateSet({
        added_by: won.approved_by,
        created_at: sql<Date>`clock_timestamp()`,
        removed_at: null,
      }),
    )
    .execute()
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
