/**
 * One attempt to bring a machine into a Space: opening it, answering it, and collecting it.
 *
 * Both ways in are this table. A person at a browser opens one that is already approved and pastes
 * its secret onto a server; a machine opens one that is not and waits for somebody to say yes. An
 * auth key is not a second mechanism — it is an enrolment that arrived approved.
 *
 * Locks, in the order every path here takes them:
 *   1. the `enrolments` row, by a conditional update that only a first answer matches
 *   2. the `machines` row it turns into
 *
 * No advisory lock. Every transition here is one `update ... where <still open>`: whoever gets
 * there second updates nothing and is told what already happened. A lock would only move that
 * decision out of SQL, where it is enforced, into TypeScript, where it is remembered.
 */

import { sql } from 'kysely'
import { LIFETIME_MINUTES } from '../machine/enrolment.ts'
import type { UserCode } from '../machine/user-code.ts'
import type { Database } from './connection.ts'

export type OpeningEnrolment = {
  /**
   * Absent when a machine opened it: which Space it joins is the approver's to choose, and a
   * machine naming one would let an unauthenticated caller tell a real slug from a missing one.
   */
  readonly spaceId: string | undefined
  readonly machineName: string
  readonly secretHash: string
  /** Absent on the key path: nobody reads a code there, and one nobody types can only leak. */
  readonly userCode: UserCode | undefined
  /** Set on the key path, where whoever generated it has already said yes by generating it. */
  readonly approvedBy: string | undefined
}

export type Opened = {
  readonly id: string
  readonly expiresAt: Date
}

export async function openEnrolment(db: Database, opening: OpeningEnrolment): Promise<Opened> {
  const approved = opening.approvedBy === undefined ? null : sql<Date>`clock_timestamp()`

  const row = await db
    .insertInto('enrolments')
    .values({
      space_id: opening.spaceId ?? null,
      machine_name: opening.machineName,
      secret_hash: opening.secretHash,
      user_code: opening.userCode ?? null,
      approved_by: opening.approvedBy ?? null,
      approved_at: approved,
      expires_at: sql`now() + make_interval(mins => ${LIFETIME_MINUTES})`,
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

export async function enrolmentWaiting(
  db: Database,
  userCode: UserCode,
): Promise<Waiting | undefined> {
  const row = await db
    .selectFrom('enrolments')
    .select(['machine_name as machineName', 'expires_at as expiresAt'])
    .where('user_code', '=', userCode)
    .where('approved_at', 'is', null)
    .where('refused_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst()

  return row
}

export type Answered =
  | { readonly kind: 'answered' }
  /** Somebody already answered, it ran out, or there was never one by that code. */
  | { readonly kind: 'not-waiting' }

/**
 * Says yes on behalf of a person, if nobody has answered yet.
 *
 * The guard is the `where`, not a read before it: two people answering at once both run this, and
 * the second updates nothing. Reading first and deciding in TypeScript would let both through.
 */
export async function approveEnrolment(
  db: Database,
  userCode: UserCode,
  into: { readonly userId: string; readonly spaceId: string },
): Promise<Answered> {
  return answer(db, userCode, {
    approved_by: into.userId,
    space_id: into.spaceId,
    approved_at: sql`clock_timestamp()`,
  })
}

export async function refuseEnrolment(db: Database, userCode: UserCode): Promise<Answered> {
  return answer(db, userCode, { refused_at: sql`clock_timestamp()` })
}

async function answer(
  db: Database,
  userCode: UserCode,
  transition: Record<string, unknown>,
): Promise<Answered> {
  const changed = await db
    .updateTable('enrolments')
    .set(transition)
    .where('user_code', '=', userCode)
    .where('approved_at', 'is', null)
    .where('refused_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .returning('id')
    .executeTakeFirst()

  return changed === undefined ? { kind: 'not-waiting' } : { kind: 'answered' }
}
