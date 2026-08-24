import { sql } from 'kysely'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { newEnrolmentSecret, newMachineToken } from '../machine/secret.ts'
import { newUserCode } from '../machine/user-code.ts'
import { presence } from '../machine/presence.ts'
import { approveEnrolment, openEnrolment, refuseEnrolment } from './enrolment.ts'
import {
  checkIn,
  collectEnrolment,
  machineHolding,
  machinesIn,
  removeMachine,
  sayGoodbye,
} from './machine.ts'
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

/** An enrolment somebody has already said yes to, plus the secret that collects it. */
async function approved(name = 'mina-mbp'): Promise<string> {
  const secret = newEnrolmentSecret()
  const userCode = newUserCode()
  await openEnrolment(db, {
    spaceId: undefined,
    machineName: name,
    secretHash: secret.hash,
    userCode,
    approvedBy: undefined,
  })
  await approveEnrolment(db, userCode, { userId: PERSON, spaceId: SPACE })
  return secret.hash
}

async function attached(name = 'mina-mbp'): Promise<string> {
  const collected = await collectEnrolment(db, {
    secretHash: await approved(name),
    tokenHash: newMachineToken().hash,
    machineName: 'mina-mbp',
  })
  if (collected.kind !== 'granted') throw new Error('the fixture could not attach a machine')
  return collected.machineId
}

describe('collecting an approved enrolment', () => {
  it('turns it into a machine in that Space', async () => {
    const machineId = await attached()

    expect((await machinesIn(db, SPACE)).map((one) => one.id)).toEqual([machineId])
  })

  it('lets exactly one of many machines take a single key', async () => {
    // A key pasted onto ten servers. The `where` decides; reading first would admit all ten.
    const secretHash = await approved()

    const collected = await Promise.all(
      Array.from({ length: 10 }, async () =>
        collectEnrolment(db, {
          secretHash,
          tokenHash: newMachineToken().hash,
          machineName: 'mina-mbp',
        }),
      ),
    )

    expect(collected.filter((one) => one.kind === 'granted')).toHaveLength(1)
    expect(collected.filter((one) => one.kind === 'spent')).toHaveLength(9)
  })

  it('says spent rather than absent, because somebody else got in with it', async () => {
    const secretHash = await approved()
    await collectEnrolment(db, {
      secretHash,
      tokenHash: newMachineToken().hash,
      machineName: 'mina-mbp',
    })

    const again = await collectEnrolment(db, {
      secretHash,
      tokenHash: newMachineToken().hash,
      machineName: 'mina-mbp',
    })

    expect(again).toEqual({ kind: 'spent' })
  })

  it('waits while nobody has answered', async () => {
    const secret = newEnrolmentSecret()
    await openEnrolment(db, {
      spaceId: undefined,
      machineName: 'mina-mbp',
      secretHash: secret.hash,
      userCode: newUserCode(),
      approvedBy: undefined,
    })

    expect(
      await collectEnrolment(db, {
        secretHash: secret.hash,
        tokenHash: 'x',
        machineName: 'mina-mbp',
      }),
    ).toEqual({
      kind: 'waiting',
    })
  })

  it('says refused, and stays refused', async () => {
    const secret = newEnrolmentSecret()
    const userCode = newUserCode()
    await openEnrolment(db, {
      spaceId: undefined,
      machineName: 'mina-mbp',
      secretHash: secret.hash,
      userCode,
      approvedBy: undefined,
    })
    await refuseEnrolment(db, userCode)

    expect(
      await collectEnrolment(db, {
        secretHash: secret.hash,
        tokenHash: 'x',
        machineName: 'mina-mbp',
      }),
    ).toEqual({
      kind: 'refused',
    })
  })

  it('says expired once it has run out', async () => {
    const secretHash = await approved()
    await db
      .updateTable('enrolments')
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .where('secret_hash', '=', secretHash)
      .execute()

    expect(
      await collectEnrolment(db, { secretHash, tokenHash: 'x', machineName: 'mina-mbp' }),
    ).toEqual({ kind: 'expired' })
  })

  it('says there is no such enrolment for a secret nobody opened', async () => {
    expect(
      await collectEnrolment(db, {
        secretHash: newEnrolmentSecret().hash,
        tokenHash: 'x',
        machineName: 'mina-mbp',
      }),
    ).toEqual({ kind: 'no-enrolment' })
  })
})

describe('what a machine reports', () => {
  it('is the whole truth, so an uninstalled agent stops being listed', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, [
      { kind: 'claude-code', version: '2.1.4' },
      { kind: 'codex', version: '0.9.0' },
    ])

    await checkIn(db, machineId, [{ kind: 'claude-code', version: '2.1.4' }])

    const [machine] = await machinesIn(db, SPACE)
    expect(machine?.agents).toEqual([{ kind: 'claude-code', version: '2.1.4' }])
  })

  it('updates a version in place, so upgrading is not reconnecting', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, [{ kind: 'claude-code', version: '2.1.4' }])

    await checkIn(db, machineId, [{ kind: 'claude-code', version: '2.2.0' }])

    const [machine] = await machinesIn(db, SPACE)
    expect(machine?.agents).toEqual([{ kind: 'claude-code', version: '2.2.0' }])
  })

  it('is allowed to have found nothing, which is a machine with something to fix', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, [{ kind: 'codex', version: '0.9.0' }])

    await checkIn(db, machineId, [])

    const [machine] = await machinesIn(db, SPACE)
    expect(machine?.agents).toEqual([])
  })
})

describe('whether it is here', () => {
  it('is here right after checking in', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, [])

    const [machine] = await machinesIn(db, SPACE)
    expect(presence(machine?.whereabouts ?? never(), new Date())).toEqual({ state: 'here' })
  })

  it('is gone the moment it says goodbye, without waiting out the silence', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, [])

    await sayGoodbye(db, machineId)

    const [machine] = await machinesIn(db, SPACE)
    expect(presence(machine?.whereabouts ?? never(), new Date()).state).toBe('gone')
  })

  it('is here again after it comes back, without being re-approved', async () => {
    const machineId = await attached()
    await sayGoodbye(db, machineId)

    await checkIn(db, machineId, [])

    const [machine] = await machinesIn(db, SPACE)
    expect(presence(machine?.whereabouts ?? never(), new Date())).toEqual({ state: 'here' })
  })
})

describe('taking one away', () => {
  it('stops its credential working', async () => {
    const secretHash = await approved()
    const token = newMachineToken()
    const collected = await collectEnrolment(db, {
      secretHash,
      tokenHash: token.hash,
      machineName: 'mina-mbp',
    })
    if (collected.kind !== 'granted') throw new Error('the fixture could not attach a machine')

    expect(await machineHolding(db, token.hash)).toBe(collected.machineId)
    await removeMachine(db, collected.machineId, SPACE)
    expect(await machineHolding(db, token.hash)).toBeUndefined()
  })

  it('takes it off the Space screen', async () => {
    const machineId = await attached()

    await removeMachine(db, machineId, SPACE)

    expect(await machinesIn(db, SPACE)).toEqual([])
  })

  it('removes nothing when the id belongs to another Space', async () => {
    // The id alone must not be enough. Otherwise anybody holding one could take a machine out of
    // a Space they have nothing to do with.
    const machineId = await attached()

    expect(await removeMachine(db, machineId, randomUUID())).toBe(false)
    expect(await machinesIn(db, SPACE)).toHaveLength(1)
  })

  it('says so when it was already taken away', async () => {
    const machineId = await attached()
    await removeMachine(db, machineId, SPACE)

    expect(await removeMachine(db, machineId, SPACE)).toBe(false)
  })
})

function never(): never {
  throw new Error('the fixture expected a machine')
}
