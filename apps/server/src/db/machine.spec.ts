import { randomUUID } from 'node:crypto'
import { normalizeSlug, type Slug } from '@handover/universal'
import { sql } from 'kysely'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../env.ts'
import { AT_ONCE_AT_MOST, AT_ONCE_BY_DEFAULT } from '../machine/at-once.ts'
import { presence } from '../machine/presence.ts'
import { newEnrolmentSecret } from '../machine/secret.ts'
import { newUserCode } from '../machine/user-code.ts'
import { hashSecret } from '../secret.ts'
import { connect, type Database } from './connection.ts'
import { approveEnrolment, collectEnrolment, openEnrolment, refuseEnrolment } from './enrolment.ts'
import {
  checkIn,
  machineHolding,
  machinesIn,
  removeMachine,
  sayGoodbye,
  setAgentSettings,
} from './machine.ts'
import { handMachineTo, joins, removes } from './membership.ts'
import { createSpace } from './space.ts'
import { arrive } from './user.ts'

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
    emoji: '🏠',
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
  await approveEnrolment(db, userCode, { userId: PERSON })
  return secret.hash
}

/** Somebody who did not approve this machine, and never will. */
async function someoneElse(): Promise<string> {
  const address = `rui-${RUN}@example.com`
  const arrived = await db
    .transaction()
    .execute(async (tx) =>
      arrive(tx, { kind: 'email', subject: address }, { name: null, username: null, address }),
    )

  return arrived.userId
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

describe('who a machine belongs to', () => {
  it('cannot be somebody other than whoever approved it, at the moment it is written', async () => {
    // Written twice on purpose — the copy on `machines` carries the index every question about a
    // machine goes through. What must never happen is a machine *born* under the wrong person:
    // the approval would say one person while reachability, the name on the row and the
    // Disconnect button all said another, from its first day.
    //
    // Only at that moment. Since `20260909` the owner may move afterwards, because by then the
    // two columns are answering different questions — who said yes, and whose it is now.
    const secretHash = await approved()
    const stranger = await someoneElse()

    await expect(
      db
        .insertInto('machines')
        .values({
          name: 'not-theirs',
          enrolled_from: db
            .selectFrom('enrolments')
            .select('id')
            .where('secret_hash', '=', secretHash),
          owner_user_id: stranger,
          token_hash: hashSecret(`hm_${randomUUID()}`),
        })
        .execute(),
    ).rejects.toThrow(/belongs to whoever approved it/u)
  })
})

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
      connectedIn: undefined,
      found: [
        { kind: 'claude-code', version: '2.1.4' },
        { kind: 'codex', version: '0.9.0' },
      ],
    })

    await checkIn(db, machineId, {
      version: undefined,
      connectedIn: undefined,
      found: [{ kind: 'claude-code', version: '2.1.4' }],
    })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.agents).toEqual([
      { kind: 'claude-code', name: null, version: '2.1.4', models: null },
    ])
  })

  it('records which build of the CLI is on that machine', async () => {
    const machineId = await attached()

    await checkIn(db, machineId, { version: 'v0.4.0', connectedIn: undefined, found: [] })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.version).toBe('v0.4.0')
  })

  it('goes back to not knowing when a machine stops saying', async () => {
    // Not a merge. A build that says nothing about its version is one that cannot, and holding on
    // to what an older process said would name the wrong build in the one place somebody looks to
    // find out which build is misbehaving.
    const machineId = await attached()
    await checkIn(db, machineId, { version: 'v0.4.0', connectedIn: undefined, found: [] })

    await checkIn(db, machineId, { version: undefined, connectedIn: undefined, found: [] })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.version).toBeUndefined()
  })

  it('updates a version in place, so upgrading is not reconnecting', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, {
      version: undefined,
      connectedIn: undefined,
      found: [{ kind: 'claude-code', version: '2.1.4' }],
    })

    await checkIn(db, machineId, {
      version: undefined,
      connectedIn: undefined,
      found: [{ kind: 'claude-code', version: '2.2.0' }],
    })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.agents).toEqual([
      { kind: 'claude-code', name: null, version: '2.2.0', models: null },
    ])
  })

  it('keeps what an agent said it offers', async () => {
    const machineId = await attached()

    await checkIn(db, machineId, {
      version: undefined,
      connectedIn: undefined,
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
      connectedIn: undefined,
      found: [{ kind: 'claude-code', version: '2.1.4', models: SONNET }],
    })

    await checkIn(db, machineId, {
      version: undefined,
      connectedIn: undefined,
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
      connectedIn: undefined,
      found: [{ kind: 'claude-code', version: '2.1.4', models: SONNET }],
    })

    await checkIn(db, machineId, {
      version: undefined,
      connectedIn: undefined,
      found: [{ kind: 'claude-code', version: '2.2.0' }],
    })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.agents[0]?.models).toBeNull()
  })

  it('is allowed to have found nothing, which is a machine with something to fix', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, {
      version: undefined,
      connectedIn: undefined,
      found: [{ kind: 'codex', version: '0.9.0' }],
    })

    await checkIn(db, machineId, { version: undefined, connectedIn: undefined, found: [] })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(machine?.agents).toEqual([])
  })
})

describe('what its owner has decided about an agent', () => {
  async function withAgent(): Promise<string> {
    const machineId = await attached()
    await checkIn(db, machineId, {
      version: undefined,
      connectedIn: undefined,
      found: [{ kind: 'claude-code', version: '2.1.4' }],
    })
    return machineId
  }

  /**
   * What was decided, read from the row that holds it.
   *
   * Not through the Space listing, which is what a screen sees: what is under test is that a
   * decision was written down and survives, and a listing that stopped carrying one of these
   * would take the test with it while the decision was still perfectly well kept.
   */
  async function settingsOf(machineId: string) {
    return db
      .selectFrom('agent_settings')
      .select(['name', 'at_once as atOnce'])
      .where('machine_id', '=', machineId)
      .where('kind', '=', 'claude-code')
      .executeTakeFirst()
  }

  it('is the default until somebody says otherwise, and the column agrees', async () => {
    // Two places carry this number — the constant a reader reaches for and the column default a
    // row written without one gets — and an agent whose owner has said nothing has to come back
    // the same either way. Left to drift, a settings row written for a name alone would quietly
    // change how much that agent takes on.
    const machineId = await withAgent()
    await setAgentSettings(db, {
      machine: machineId,
      owner: PERSON,
      kind: 'claude-code',
      name: 'the one on my desk',
    })

    expect((await settingsOf(machineId))?.atOnce).toBe(AT_ONCE_BY_DEFAULT)
  })

  it('takes the most the door allows, and nothing past it', async () => {
    // Two places carry the ceiling — the number the door checks against and the constraint the
    // column carries — and a value between them is one this deployment accepts and the database
    // then refuses. What a person sees for typing a number slightly too big has to be a refusal,
    // not their laptop apparently breaking.
    const machineId = await withAgent()
    const most = { machine: machineId, owner: PERSON, kind: 'claude-code' as const }

    await setAgentSettings(db, { ...most, atOnce: AT_ONCE_AT_MOST })
    expect((await settingsOf(machineId))?.atOnce).toBe(AT_ONCE_AT_MOST)

    await expect(setAgentSettings(db, { ...most, atOnce: AT_ONCE_AT_MOST + 1 })).rejects.toThrow(
      /agent_settings_at_once_check/u,
    )
  })

  it('keeps the name when only how many at a time changes', async () => {
    const machineId = await withAgent()
    await setAgentSettings(db, {
      machine: machineId,
      owner: PERSON,
      kind: 'claude-code',
      name: 'the one on my desk',
    })

    await setAgentSettings(db, {
      machine: machineId,
      owner: PERSON,
      kind: 'claude-code',
      atOnce: 7,
    })

    expect(await settingsOf(machineId)).toMatchObject({ name: 'the one on my desk', atOnce: 7 })
  })

  it('keeps how many at a time when the name comes off', async () => {
    // Taking a name off used to delete the row, which is why it cannot any more: the row is
    // carrying a second decision now, and forgetting that one was never what was asked for.
    const machineId = await withAgent()
    await setAgentSettings(db, {
      machine: machineId,
      owner: PERSON,
      kind: 'claude-code',
      name: 'the one on my desk',
      atOnce: 7,
    })

    await setAgentSettings(db, {
      machine: machineId,
      owner: PERSON,
      kind: 'claude-code',
      name: null,
    })

    expect(await settingsOf(machineId)).toMatchObject({ name: null, atOnce: 7 })
  })

  it('survives an agent going missing from a report and coming back', async () => {
    const machineId = await withAgent()
    await setAgentSettings(db, {
      machine: machineId,
      owner: PERSON,
      kind: 'claude-code',
      atOnce: 7,
    })

    await checkIn(db, machineId, { version: undefined, connectedIn: undefined, found: [] })
    await checkIn(db, machineId, {
      version: undefined,
      connectedIn: undefined,
      found: [{ kind: 'claude-code', version: '2.1.4' }],
    })

    expect((await settingsOf(machineId))?.atOnce).toBe(7)
  })

  it('is nobody else’s to change', async () => {
    const machineId = await withAgent()

    const done = await setAgentSettings(db, {
      machine: machineId,
      owner: await someoneElse(),
      kind: 'claude-code',
      atOnce: 7,
    })

    expect(done).toBe(false)
  })
})

describe('whether it is here', () => {
  it('is here right after checking in', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, { version: undefined, connectedIn: undefined, found: [] })

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(presence(machine?.whereabouts ?? never(), new Date())).toEqual({ state: 'here' })
  })

  it('is gone the moment it says goodbye, without waiting out the silence', async () => {
    const machineId = await attached()
    await checkIn(db, machineId, { version: undefined, connectedIn: undefined, found: [] })

    await sayGoodbye(db, machineId)

    const [machine] = (await machinesIn(db, SPACE)).machines
    expect(presence(machine?.whereabouts ?? never(), new Date()).state).toBe('gone')
  })

  it('is here again after it comes back, without being re-approved', async () => {
    const machineId = await attached()
    await sayGoodbye(db, machineId)

    await checkIn(db, machineId, { version: undefined, connectedIn: undefined, found: [] })

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
    await removeMachine(db, { machine: collected.machineId, owner: PERSON })
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

    await removeMachine(db, { machine: machineId, owner: PERSON })

    expect((await machinesIn(db, SPACE)).machines).toEqual([])
  })

  it('removes nothing when the id belongs to another Space', async () => {
    // The id alone must not be enough. Otherwise anybody holding one could take a machine out of
    // a Space they have nothing to do with.
    const machineId = await attached()

    expect(await removeMachine(db, { machine: machineId, owner: randomUUID() })).toBe(false)
    expect((await machinesIn(db, SPACE)).machines).toHaveLength(1)
  })

  it('says so when it was already taken away', async () => {
    const machineId = await attached()
    await removeMachine(db, { machine: machineId, owner: PERSON })

    expect(await removeMachine(db, { machine: machineId, owner: PERSON })).toBe(false)
  })
})

function never(): never {
  throw new Error('the fixture expected a machine')
}

describe('handing a machine to another person', () => {
  it('moves whose it is, and leaves who approved it alone', async () => {
    // Two questions, not one fact written twice. Since `20260909` the row may move — and the
    // enrolment still says who let it in, which is history and `prd.md` 05 ⑦ promises to keep.
    const machineId = await attached()
    const rui = await someoneElse()
    await joins(db, { userId: rui, spaceId: SPACE, slug: `s-${RUN.slice(0, 8)}` })

    expect(await handMachineTo(db, { spaceId: SPACE, machineId, userId: rui })).toEqual({
      kind: 'moved',
    })

    const row = await db
      .selectFrom('machines')
      .innerJoin('enrolments', 'enrolments.id', 'machines.enrolled_from')
      .select(['machines.owner_user_id as owner', 'enrolments.approved_by as approvedBy'])
      .where('machines.id', '=', machineId)
      .executeTakeFirstOrThrow()

    expect([row.owner, row.approvedBy]).toEqual([rui, PERSON])
  })

  it('keeps it reachable from the Space, which is the whole point of moving it', async () => {
    // Tailscale's lesson, avoided rather than repeated: deleting a user there deletes their
    // devices and the connections stop. Handing the team's build server to somebody who is
    // staying is how that never happens here.
    const machineId = await attached('build-server-1')
    const rui = await someoneElse()
    await joins(db, { userId: rui, spaceId: SPACE, slug: `s-${RUN.slice(0, 8)}` })
    await handMachineTo(db, { spaceId: SPACE, machineId, userId: rui })

    await removes(db, { spaceId: SPACE, userId: PERSON })

    expect((await machinesIn(db, SPACE)).machines.map((one) => one.id)).toEqual([machineId])
  })

  it('refuses somebody who is not in this Space', async () => {
    const machineId = await attached()
    const stranger = await someoneElse()

    expect(await handMachineTo(db, { spaceId: SPACE, machineId, userId: stranger })).toEqual({
      kind: 'not-a-member',
    })
  })
})
