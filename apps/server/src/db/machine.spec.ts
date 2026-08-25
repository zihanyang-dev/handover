import { sql } from 'kysely'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashSecret, newEnrolmentSecret } from '../machine/secret.ts'
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
    kind: 'asking',
    machineName: name,
    secretHash: secret.hash,
    userCode,
  })
  await approveEnrolment(db, userCode, { userId: PERSON, spaceId: SPACE })
  return secret.hash
}

async function attached(name = 'mina-mbp'): Promise<string> {
  const collected = await collectEnrolment(db, {
    secretHash: await approved(name),
    tokenHash: hashSecret(`hm_${randomUUID()}`),
    machineName: 'mina-mbp',
  })
  if (collected.kind !== 'granted') throw new Error('the fixture could not attach a machine')
  return collected.machineId
}

describe('collecting an approved enrolment', () => {
  it('turns it into a machine in that Space', async () => {
    const machineId = await attached()

    expect((await machinesIn(db, SPACE)).machines.map((one) => one.id)).toEqual([machineId])
  })

  it('lets exactly one of many machines take a single key', async () => {
    // A key pasted onto ten servers. The `where` decides; reading first would admit all ten.
    const secretHash = await approved()

    const collected = await Promise.all(
      Array.from({ length: 10 }, async () =>
        collectEnrolment(db, {
          secretHash,
          tokenHash: hashSecret(`hm_${randomUUID()}`),
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
      tokenHash: hashSecret(`hm_${randomUUID()}`),
      machineName: 'mina-mbp',
    })

    const again = await collectEnrolment(db, {
      secretHash,
      tokenHash: hashSecret(`hm_${randomUUID()}`),
      machineName: 'mina-mbp',
    })

    expect(again).toEqual({ kind: 'spent' })
  })

  it('waits while nobody has answered', async () => {
    const secret = newEnrolmentSecret()
    await openEnrolment(db, {
      kind: 'asking',
      machineName: 'mina-mbp',
      secretHash: secret.hash,
      userCode: newUserCode(),
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
      kind: 'asking',
      machineName: 'mina-mbp',
      secretHash: secret.hash,
      userCode,
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

/** One model, in the shape an adapter reports it. Enough to tell a stored list from a lost one. */
const SONNET = [
  { id: 'sonnet-5', name: 'Sonnet 5', about: 'Fast', efforts: ['low', 'high'], isDefault: true },
]

describe('what a machine reports', () => {
  it('is the whole truth, so an uninstalled agent stops being listed', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, {
      version: undefined,
      found: [
        { kind: 'claude-code', version: '2.1.4' },
        { kind: 'codex', version: '0.9.0' },
      ],
    })

    await checkIn(db, machineId, {
      version: undefined,
      found: [{ kind: 'claude-code', version: '2.1.4' }],
    })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.agents).toEqual([{ kind: 'claude-code', version: '2.1.4', models: null }])
  })

  it('records which build of the CLI is on that machine', async () => {
    const machineId = await attached()

    await checkIn(db, machineId, { version: 'v0.4.0', found: [] })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.version).toBe('v0.4.0')
  })

  it('goes back to not knowing when a machine stops saying', async () => {
    // Not a merge. A build that says nothing about its version is one that cannot, and holding on
    // to what an older process said would name the wrong build in the one place somebody looks to
    // find out which build is misbehaving.
    const machineId = await attached()
    await checkIn(db, machineId, { version: 'v0.4.0', found: [] })

    await checkIn(db, machineId, { version: undefined, found: [] })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.version).toBeUndefined()
  })

  it('updates a version in place, so upgrading is not reconnecting', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, {
      version: undefined,
      found: [{ kind: 'claude-code', version: '2.1.4' }],
    })

    await checkIn(db, machineId, {
      version: undefined,
      found: [{ kind: 'claude-code', version: '2.2.0' }],
    })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.agents).toEqual([{ kind: 'claude-code', version: '2.2.0', models: null }])
  })

  it('keeps what an agent said it offers', async () => {
    const machineId = await attached()

    await checkIn(db, machineId, {
      version: undefined,
      found: [{ kind: 'claude-code', version: '2.1.4', models: SONNET }],
    })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.agents[0]?.models).toEqual(SONNET)
  })

  it('leaves the list alone on every report that says nothing about it', async () => {
    // The ordinary report, and the whole reason the list is stored at all: asking an agent what
    // it offers costs starting it up, so a machine asks once per version and stays quiet after.
    const machineId = await attached()
    await checkIn(db, machineId, {
      version: undefined,
      found: [{ kind: 'claude-code', version: '2.1.4', models: SONNET }],
    })

    await checkIn(db, machineId, {
      version: undefined,
      found: [{ kind: 'claude-code', version: '2.1.4' }],
    })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.agents[0]?.models).toEqual(SONNET)
  })

  it('forgets the list when the version moved and nobody said what the new one offers', async () => {
    // What the last version offered is not what this one offers, and showing yesterday's list
    // would be this side inventing an answer about a version nobody has asked.
    const machineId = await attached()
    await checkIn(db, machineId, {
      version: undefined,
      found: [{ kind: 'claude-code', version: '2.1.4', models: SONNET }],
    })

    await checkIn(db, machineId, {
      version: undefined,
      found: [{ kind: 'claude-code', version: '2.2.0' }],
    })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.agents[0]?.models).toBeNull()
  })

  it('is allowed to have found nothing, which is a machine with something to fix', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, {
      version: undefined,
      found: [{ kind: 'codex', version: '0.9.0' }],
    })

    await checkIn(db, machineId, { version: undefined, found: [] })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.agents).toEqual([])
  })
})

describe('whether it is here', () => {
  it('is here right after checking in', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, { version: undefined, found: [] })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(presence(machine?.whereabouts ?? never(), new Date())).toEqual({ state: 'here' })
  })

  it('is gone the moment it says goodbye, without waiting out the silence', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, { version: undefined, found: [] })

    await sayGoodbye(db, machineId)

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(presence(machine?.whereabouts ?? never(), new Date()).state).toBe('gone')
  })

  it('is here again after it comes back, without being re-approved', async () => {
    const machineId = await attached()
    await sayGoodbye(db, machineId)

    await checkIn(db, machineId, { version: undefined, found: [] })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(presence(machine?.whereabouts ?? never(), new Date())).toEqual({ state: 'here' })
  })
})

describe('taking one away', () => {
  it('stops its credential working', async () => {
    const secretHash = await approved()
    const token = `hm_${randomUUID()}`
    const collected = await collectEnrolment(db, {
      secretHash,
      tokenHash: hashSecret(token),
      machineName: 'mina-mbp',
    })
    if (collected.kind !== 'granted') throw new Error('the fixture could not attach a machine')

    expect(await machineHolding(db, hashSecret(token))).toBe(collected.machineId)
    await removeMachine(db, { machine: collected.machineId, space: SPACE })
    expect(await machineHolding(db, hashSecret(token))).toBeUndefined()
  })

  it('says when it looked, from the clock that wrote what it is comparing against', async () => {
    // `last_seen_at` is `clock_timestamp()`. Measuring the silence since then against this
    // process's clock would be two clocks deciding one fact — and a few seconds of drift reads as
    // a whole Space that is gone, or one that never goes, with nothing raising an error.
    await attached()

    const seen = await machinesIn(db, SPACE)
    const [machine] = seen.machines

    expect(machine).toBeDefined()
    expect(seen.asOf.getTime()).toBeGreaterThanOrEqual(
      machine?.whereabouts.lastSeenAt.getTime() ?? 0,
    )
  })

  it('takes it off the Space screen', async () => {
    const machineId = await attached()

    await removeMachine(db, { machine: machineId, space: SPACE })

    expect((await machinesIn(db, SPACE)).machines).toEqual([])
  })

  it('removes nothing when the id belongs to another Space', async () => {
    // The id alone must not be enough. Otherwise anybody holding one could take a machine out of
    // a Space they have nothing to do with.
    const machineId = await attached()

    expect(await removeMachine(db, { machine: machineId, space: randomUUID() })).toBe(false)
    expect((await machinesIn(db, SPACE)).machines).toHaveLength(1)
  })

  it('says so when it was already taken away', async () => {
    const machineId = await attached()
    await removeMachine(db, { machine: machineId, space: SPACE })

    expect(await removeMachine(db, { machine: machineId, space: SPACE })).toBe(false)
  })
})

function never(): never {
  throw new Error('the fixture expected a machine')
}
