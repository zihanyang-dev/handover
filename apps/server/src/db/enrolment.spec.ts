import { randomUUID } from 'node:crypto'
import { normalizeSlug, type Slug } from '@handover/universal'
import { sql } from 'kysely'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../env.ts'
import { AGENT_KIND_NAMES } from '../machine/agent-kind.ts'
import { newEnrolmentSecret } from '../machine/secret.ts'
import { newUserCode, type UserCode } from '../machine/user-code.ts'
import { hashSecret } from '../secret.ts'
import { connect, type Database } from './connection.ts'
import {
  type MachineAsking,
  approveEnrolment,
  collectEnrolment,
  enrolmentWaiting,
  existingMachinesFor,
  openEnrolment,
  refuseEnrolment,
} from './enrolment.ts'
import { addMachineToSpace, machineHolding } from './machine.ts'
import { becomes, joins, removes, ROLE } from './membership.ts'
import { createSpace } from './space.ts'
import { arrive } from './user.ts'

const env = loadEnv()
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

/** A fresh Space and person per test, so no test depends on the database being empty. */
let RUN = ''
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

  // A Space, though nothing here names one: enrolling is about whose machine it is, not about
  // where it may be used. It is made so that a person who has one is the ordinary case under test.
  const name = `Acme ${RUN.slice(0, 8)}`
  const made = await createSpace(db, {
    requestKey: `space-${RUN}`,
    userId: PERSON,
    displayName: name,
    emoji: '🏠',
    slug: normalizeSlug(name) as Slug,
  })
  if (made.kind !== 'created') throw new Error('the fixture could not make a Space')
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

async function connectedMachine(
  machineName: string,
  owner = PERSON,
): Promise<{ readonly id: string; readonly token: string }> {
  const secret = newEnrolmentSecret()
  await openEnrolment(db, {
    kind: 'key',
    secretHash: secret.hash,
    approvedBy: owner,
  })
  const token = `hm_${randomUUID()}`
  const collected = await collectEnrolment(db, {
    secretHash: secret.hash,
    tokenHash: hashSecret(token),
    machineName,
  })
  if (collected.kind !== 'granted') throw new Error('the fixture could not connect a machine')

  return { id: collected.machineId, token }
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
      .select('approved_by')
      .where('secret_hash', '=', asked.secretHash)
      .executeTakeFirstOrThrow()

    expect(row.approved_by).toBeNull()
  })

  it('is already answered when a person generated it, so nothing waits on a code', async () => {
    // The key path. Generating it in a browser is the approval; there is no second step and no
    // code, because a code nobody will ever type can only leak.
    const secret = newEnrolmentSecret()
    await openEnrolment(db, {
      kind: 'key',
      secretHash: secret.hash,
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

    expect(await approveEnrolment(db, code, { userId: PERSON })).toEqual({
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
      Array.from({ length: 10 }, async () => approveEnrolment(db, code, { userId: PERSON })),
    )

    expect(answers.filter((answer) => answer.kind === 'answered')).toHaveLength(1)
  })

  it('does not add a machine after its approver left the chosen Space before collection', async () => {
    const membership = await db
      .selectFrom('memberships')
      .innerJoin('spaces', 'spaces.id', 'memberships.space_id')
      .select(['memberships.space_id', 'spaces.slug'])
      .where('memberships.user_id', '=', PERSON)
      .where('memberships.revoked_at', 'is', null)
      .executeTakeFirstOrThrow()
    const asked = opening()
    await openEnrolment(db, asked)
    await approveEnrolment(db, asked.userCode, {
      userId: PERSON,
      approvedSpaceId: membership.space_id,
    })
    const otherAddress = `rui-${RUN}@example.com`
    const other = await db
      .transaction()
      .execute(async (tx) =>
        arrive(
          tx,
          { kind: 'email', subject: otherAddress },
          { name: null, username: null, address: otherAddress },
        ),
      )
    await joins(db, {
      userId: other.userId,
      spaceId: membership.space_id,
      slug: membership.slug,
    })
    await becomes(db, { spaceId: membership.space_id, userId: other.userId }, ROLE.owner)
    await removes(db, { spaceId: membership.space_id, userId: PERSON })

    const collected = await collectEnrolment(db, {
      secretHash: asked.secretHash,
      tokenHash: hashSecret(`hm_${randomUUID()}`),
      machineName: asked.machineName,
    })
    if (collected.kind !== 'granted') throw new Error('the fixture could not connect a machine')
    const available = await db
      .selectFrom('space_machines')
      .select('machine_id')
      .where('space_id', '=', membership.space_id)
      .where('machine_id', '=', collected.machineId)
      .where('removed_at', 'is', null)
      .executeTakeFirst()

    expect(available).toBeUndefined()
  })

  it('offers only this person’s active, same-named identities for reconnection', async () => {
    const machineName = `mina-mbp-${RUN.slice(0, 8)}`
    const mine = await connectedMachine(machineName)
    const otherAddress = `rui-${RUN}@example.com`
    const other = await db
      .transaction()
      .execute(async (tx) =>
        arrive(
          tx,
          { kind: 'email', subject: otherAddress },
          { name: null, username: null, address: otherAddress },
        ),
      )
    await connectedMachine(machineName, other.userId)
    await connectedMachine(`${machineName}-other`)

    const candidates = await existingMachinesFor(db, {
      ownerUserId: PERSON,
      machineName,
    })

    expect(candidates.machines.map((machine) => machine.id)).toEqual([mine.id])
  })

  it('reconnects an existing identity only when the person explicitly chose it', async () => {
    const machineName = `mina-mbp-${RUN.slice(0, 8)}`
    const existing = await connectedMachine(machineName)
    const membership = await db
      .selectFrom('memberships')
      .select('space_id')
      .where('user_id', '=', PERSON)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow()
    await addMachineToSpace(db, {
      spaceId: membership.space_id,
      machineId: existing.id,
      userId: PERSON,
    })
    const asked = opening({ machineName })
    await openEnrolment(db, asked)

    expect(
      await approveEnrolment(db, asked.userCode, {
        userId: PERSON,
        replaceMachineId: existing.id,
      }),
    ).toEqual({ kind: 'answered' })

    const newToken = `hm_${randomUUID()}`
    const collected = await collectEnrolment(db, {
      secretHash: asked.secretHash,
      tokenHash: hashSecret(newToken),
      machineName,
    })
    const rows = await db
      .selectFrom('machines')
      .select(['id', 'token_hash', 'left_at'])
      .where('owner_user_id', '=', PERSON)
      .where('name', '=', machineName)
      .where('removed_at', 'is', null)
      .execute()

    expect(collected).toEqual({ kind: 'granted', machineId: existing.id })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: existing.id,
      token_hash: hashSecret(newToken),
    })
    expect(rows[0]?.left_at).toBeInstanceOf(Date)
    expect(await machineHolding(db, hashSecret(existing.token))).toBeUndefined()
    expect(await machineHolding(db, hashSecret(newToken))).toBe(existing.id)
    expect(
      await db
        .selectFrom('space_machines')
        .select('machine_id')
        .where('space_id', '=', membership.space_id)
        .where('machine_id', '=', existing.id)
        .where('removed_at', 'is', null)
        .executeTakeFirst(),
    ).toEqual({ machine_id: existing.id })
  })

  it('lets only one uncollected reconnection replace the same identity', async () => {
    const machineName = `mina-mbp-${RUN.slice(0, 8)}`
    const existing = await connectedMachine(machineName)
    const first = opening({ machineName })
    const second = opening({ machineName })
    await openEnrolment(db, first)
    await openEnrolment(db, second)

    const answers = await Promise.all([
      approveEnrolment(db, first.userCode, {
        userId: PERSON,
        replaceMachineId: existing.id,
      }),
      approveEnrolment(db, second.userCode, {
        userId: PERSON,
        replaceMachineId: existing.id,
      }),
    ])

    expect(answers.map((answer) => answer.kind).sort()).toEqual(['answered', 'cannot-replace'])
  })

  it('releases an uncollected reconnection after its enrolment expires', async () => {
    const machineName = `mina-mbp-${RUN.slice(0, 8)}`
    const existing = await connectedMachine(machineName)
    const abandoned = opening({ machineName })
    await openEnrolment(db, abandoned)
    await approveEnrolment(db, abandoned.userCode, {
      userId: PERSON,
      replaceMachineId: existing.id,
    })
    await ageOut(abandoned.userCode)

    const retried = opening({ machineName })
    await openEnrolment(db, retried)

    expect(
      await approveEnrolment(db, retried.userCode, {
        userId: PERSON,
        replaceMachineId: existing.id,
      }),
    ).toEqual({ kind: 'answered' })
  })

  it('still creates another identity when the person explicitly chose another machine', async () => {
    const machineName = `mina-mbp-${RUN.slice(0, 8)}`
    const existing = await connectedMachine(machineName)
    const asked = opening({ machineName })
    await openEnrolment(db, asked)
    await approveEnrolment(db, asked.userCode, { userId: PERSON })

    const collected = await collectEnrolment(db, {
      secretHash: asked.secretHash,
      tokenHash: hashSecret(`hm_${randomUUID()}`),
      machineName,
    })

    expect(collected).toMatchObject({ kind: 'granted' })
    expect(collected).not.toMatchObject({ machineId: existing.id })
  })

  it('does not replace a differently named identity by id', async () => {
    const existing = await connectedMachine(`other-${RUN.slice(0, 8)}`)
    const asked = opening()
    await openEnrolment(db, asked)

    expect(
      await approveEnrolment(db, asked.userCode, {
        userId: PERSON,
        replaceMachineId: existing.id,
      }),
    ).toEqual({ kind: 'cannot-replace' })
    expect(await enrolmentWaiting(db, asked.userCode)).toBeDefined()
  })

  it('cannot be answered once it has run out', async () => {
    const asked = opening()
    await openEnrolment(db, asked)
    const code = asked.userCode
    await ageOut(code)

    expect(await approveEnrolment(db, code, { userId: PERSON })).toEqual({
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
