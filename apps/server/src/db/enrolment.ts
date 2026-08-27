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
 *
 * No advisory lock. Every transition here is one `update ... where <still open>`: whoever gets
 * there second updates nothing and is told what already happened. A lock would only move that
 * decision out of SQL, where it is enforced, into TypeScript, where it is remembered.
 */

import { sql, type UpdateObject } from 'kysely'
import { LIFETIME_MINUTES } from '../machine/enrolment.ts'
import type { UserCode } from '../machine/user-code.ts'
import type { DB } from '../../generated/db.ts'
import type { Database } from './connection.ts'

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

export async function enrolmentWaiting(
  db: Database,
  userCode: UserCode,
): Promise<Waiting | undefined> {
  const row = await db
    .selectFrom('enrolments')
    .select(['machine_name as machineName', 'expires_at as expiresAt'])
    // Only the code path has a `user_code`, and only that path records a name — so a row found
    // here always has one, and nothing downstream has to wonder what to show.
    .$narrowType<{ machineName: string }>()
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
 *
 * No Space in it: what somebody agrees to is that this machine is theirs. Where it can be reached
 * from follows from where they are a member, which is not a decision anybody makes here.
 */
export async function approveEnrolment(
  db: Database,
  userCode: UserCode,
  by: { readonly userId: string },
): Promise<Answered> {
  return answer(db, userCode, {
    approved_by: by.userId,
    approved_at: sql`clock_timestamp()`,
  })
}

export async function refuseEnrolment(db: Database, userCode: UserCode): Promise<Answered> {
  return answer(db, userCode, { refused_at: sql`clock_timestamp()` })
}

/** Typed against the table, so a column name that is not one is a compile error, not a 500. */
type Transition = UpdateObject<DB, 'enrolments'>

async function answer(db: Database, userCode: UserCode, transition: Transition): Promise<Answered> {
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
