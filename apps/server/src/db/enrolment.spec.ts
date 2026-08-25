import { sql } from 'kysely'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { newUserCode, type UserCode } from '../machine/user-code.ts'
import { hashSecret, newEnrolmentSecret } from '../machine/secret.ts'
import { AGENT_KIND_NAMES } from '../machine/agent-kind.ts'
import {
  approveEnrolment,
  enrolmentWaiting,
  openEnrolment,
  refuseEnrolment,
  type MachineAsking,
} from './enrolment.ts'
import { collectEnrolment } from './machine.ts'
import { arrive } from './user.ts'
import { createSpace } from './space.ts'
import { connect, type Database } from './connection.ts'
import { loadEnv } from '../env.ts'
import { normalizeSlug, type Slug } from '@handover/universal'

const env = loadEnv()
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

/** A fresh Space and person per test, so no test depends on the database being empty. */
let RUN = ''
let SPACE = ''
let PERSON = ''

beforeEach(async () => {
  RUN = randomUUID()
  const address = `mina-${RUN}@example.com`
  const arrived = await db
    .transaction()
    .execute(async (tx) =>
      arrive(tx, { kind: 'email', subject: address }, { name: null, username: null, address }),
    )
  PERSON = arrived.userId

  const name = `Acme ${RUN.slice(0, 8)}`
  const made = await createSpace(db, {
    requestKey: `space-${RUN}`,
    userId: PERSON,
    displayName: name,
    slug: normalizeSlug(name) as Slug,
  })
  if (made.kind !== 'created') throw new Error('the fixture could not make a Space')
  SPACE = made.space.id
})

/** A machine that showed a code and is waiting for somebody to answer it. */
function opening(overrides: Partial<MachineAsking> = {}): MachineAsking {
  return {
    kind: 'asking',
    machineName: `mina-mbp-${RUN.slice(0, 8)}`,
    secretHash: newEnrolmentSecret().hash,
    userCode: newUserCode(),
    ...overrides,
  }
}

async function ageOut(userCode: UserCode): Promise<void> {
  await db
    .updateTable('enrolments')
    .set({ expires_at: sql<Date>`now() - interval '1 second'` })
    .where('user_code', '=', userCode)
    .execute()
}

describe('opening one', () => {
  it('waits for an answer when a machine opened it', async () => {
    const asked = opening()
    await openEnrolment(db, asked)

    expect(await enrolmentWaiting(db, asked.userCode)).toMatchObject({
      machineName: asked.machineName,
    })
  })

  it("does not carry a Space, because that is the approver's to choose", async () => {
    // A machine naming one would also let an unauthenticated caller tell a real slug from a
    // missing one by the answer it got.
    const asked = opening()
    await openEnrolment(db, asked)

    const row = await db
      .selectFrom('enrolments')
      .select('space_id')
      .where('secret_hash', '=', asked.secretHash)
      .executeTakeFirstOrThrow()

    expect(row.space_id).toBeNull()
  })

  it('is already answered when a person generated it, so nothing waits on a code', async () => {
    // The key path. Generating it in a browser is the approval; there is no second step and no
    // code, because a code nobody will ever type can only leak.
    const secret = newEnrolmentSecret()
    await openEnrolment(db, {
      kind: 'key',
      secretHash: secret.hash,
      spaceId: SPACE,
      approvedBy: PERSON,
    })

    const collected = await collectEnrolment(db, {
      secretHash: secret.hash,
      tokenHash: hashSecret(`hm_${randomUUID()}`),
      machineName: 'mina-mbp',
    })

    expect(collected.kind).toBe('granted')
  })
})

describe('answering one', () => {
  it('takes the first answer and refuses the second, whichever way round', async () => {
    const asked = opening()
    await openEnrolment(db, asked)
    const code = asked.userCode

    expect(await approveEnrolment(db, code, { userId: PERSON, spaceId: SPACE })).toEqual({
      kind: 'answered',
    })
    expect(await refuseEnrolment(db, code)).toEqual({ kind: 'not-waiting' })
  })

  it('lets one of many simultaneous answers through, and only one', async () => {
    // Two tabs, two taps. The guard is the `where`, so the loser updates nothing — reading first
    // and deciding in TypeScript would let both through.
    const asked = opening()
    await openEnrolment(db, asked)
    const code = asked.userCode

    const answers = await Promise.all(
      Array.from({ length: 10 }, async () =>
        approveEnrolment(db, code, { userId: PERSON, spaceId: SPACE }),
      ),
    )

    expect(answers.filter((answer) => answer.kind === 'answered')).toHaveLength(1)
  })

  it('cannot be answered once it has run out', async () => {
    const asked = opening()
    await openEnrolment(db, asked)
    const code = asked.userCode
    await ageOut(code)

    expect(await approveEnrolment(db, code, { userId: PERSON, spaceId: SPACE })).toEqual({
      kind: 'not-waiting',
    })
    expect(await enrolmentWaiting(db, code)).toBeUndefined()
  })

  it('shows nothing for a code nobody opened', async () => {
    expect(await enrolmentWaiting(db, newUserCode())).toBeUndefined()
  })
})

describe('the kinds the database will accept', () => {
  /**
   * The check constraint lives in SQL and the list lives in TypeScript, and no compiler crosses
   * that line. Comparing them catches drift in either direction: an agent added to the code
   * without a migration, and one dropped from the code but still allowed by the database.
   */
  it('is exactly the list the code has', async () => {
    const constraint = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conname = 'agents_kind_check'
    `.execute(db)

    const allowed = [...(constraint.rows[0]?.definition ?? '').matchAll(/'([a-z-]+)'/gu)].map(
      (found) => found[1],
    )

    expect(new Set(allowed)).toEqual(new Set(AGENT_KIND_NAMES))
  })
})
