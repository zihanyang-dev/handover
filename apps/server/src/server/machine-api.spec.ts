import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { connect, type Database } from '../db/connection.ts'
import { createSpace } from '../db/space.ts'
import { openSession } from '../db/session.ts'
import { arrive } from '../db/user.ts'
import { loadEnv } from '../env.ts'
import { newSessionToken } from '../identity/session.ts'
import { SILENT_FOR_SECONDS } from '../machine/presence.ts'
import { approvalApi } from './approval-api.ts'
import { enrolmentApi } from './enrolment-api.ts'
import { machineApi } from './machine-api.ts'
import { SESSION_COOKIE } from './session.ts'
import { normalizeSlug, type Slug } from '@handover/universal'
import { sql } from 'kysely'

const env = loadEnv()
const db: Database = connect(env)
const enrolments = enrolmentApi({ db, webOrigin: 'http://localhost:5173' }).route(
  '/',
  approvalApi({ db }),
)
const app = machineApi({ db })

afterAll(async () => {
  await db.destroy()
})

let RUN = ''
let SLUG = ''
let COOKIE = ''

beforeEach(async () => {
  RUN = randomUUID()
  const address = `mina-${RUN}@example.com`
  const arrived = await db
    .transaction()
    .execute(async (tx) =>
      arrive(tx, { kind: 'email', subject: address }, { name: null, username: null, address }),
    )

  const token = newSessionToken()
  await openSession(db, { user: arrived.userId, tokenHash: token.hash })
  COOKIE = `${SESSION_COOKIE}=${token.token}`

  const name = `Acme ${RUN.slice(0, 8)}`
  SLUG = normalizeSlug(name) as string
  const made = await createSpace(db, {
    requestKey: `space-${RUN}`,
    userId: arrived.userId,
    displayName: name,
    slug: SLUG as Slug,
  })
  if (made.kind !== 'created') throw new Error('the fixture could not make a Space')
})

/** A machine that got in, and the credential it holds. */
async function attached(machineName = 'mina-mbp'): Promise<{ token: string; id: string }> {
  // Minted here because a machine mints its own: the server only ever sees the hash.
  const token = `hm_${randomUUID()}`
  const asked = (await (
    await enrolments.request('/enrolments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineName }),
    })
  ).json()) as { secret: string; userCode: string }

  await enrolments.request(`/spaces/${SLUG}/enrolments/${asked.userCode}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: COOKIE },
  })

  const collected = (await (
    await enrolments.request('/enrolments/collect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: asked.secret, machineName, token }),
    })
  ).json()) as { machineId: string }

  return { token, id: collected.machineId }
}

async function asMachine(
  token: string,
  path: string,
  method = 'POST',
  json: unknown = { found: [] },
) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(method === 'DELETE' ? {} : { body: JSON.stringify(json) }),
  })
}

type Seen = {
  machines: { id: string; name: string; presence: { state: string }; agents: unknown[] }[]
}

async function seenInSpace(): Promise<Seen> {
  const answered = await app.request(`/spaces/${SLUG}/machines`, { headers: { cookie: COOKIE } })
  return (await answered.json()) as Seen
}

/** Another Space belonging to the same person, for testing what an id alone must not do. */
async function anotherSpace(): Promise<string> {
  const name = `Beta ${RUN.slice(0, 8)}`
  const slug = normalizeSlug(name) as Slug
  const answered = await db
    .selectFrom('memberships')
    .innerJoin('spaces', 'spaces.id', 'memberships.space_id')
    .select('memberships.user_id as userId')
    .where('spaces.slug', '=', SLUG)
    .executeTakeFirstOrThrow()

  const made = await createSpace(db, {
    requestKey: `other-${RUN}`,
    userId: answered.userId,
    displayName: name,
    slug,
  })
  if (made.kind !== 'created') throw new Error('the fixture could not make a second Space')
  return slug
}

describe('what a machine reports', () => {
  it('shows up in the Space with what it found', async () => {
    const machine = await attached()

    await asMachine(machine.token, '/machines/current/poll', 'POST', {
      found: [{ command: 'claude', version: '2.1.4' }],
    })

    expect((await seenInSpace()).machines[0]).toMatchObject({
      name: 'mina-mbp',
      presence: { state: 'here' },
      agents: [{ kind: 'claude-code', version: '2.1.4', models: [] }],
    })
  })

  it('drops a command this deployment does not know, and stays connected', async () => {
    const machine = await attached()

    const answered = await asMachine(machine.token, '/machines/current/poll', 'POST', {
      found: [
        { command: 'claude', version: '2.1.4' },
        { command: 'some-agent-from-next-year', version: '1.0.0' },
      ],
    })

    expect(answered.status).toBe(200)
    expect((await seenInSpace()).machines[0]?.agents).toEqual([
      { kind: 'claude-code', version: '2.1.4', models: [] },
    ])
  })

  it('is here with nothing installed, which is a machine with something to fix', async () => {
    // Not the same as not being connected. Merging the two would send somebody to reconnect a
    // machine that is already connected.
    const machine = await attached()

    await asMachine(machine.token, '/machines/current/poll')

    expect((await seenInSpace()).machines[0]).toMatchObject({
      presence: { state: 'here' },
      agents: [],
    })
  })
})

describe('whether it is here', () => {
  it('is gone the moment it says it is stopping', async () => {
    const machine = await attached()
    await asMachine(machine.token, '/machines/current/poll')

    await asMachine(machine.token, '/machines/current/session', 'DELETE')

    expect((await seenInSpace()).machines[0]?.presence.state).toBe('gone')
  })

  it('is gone after long enough without a word', async () => {
    const machine = await attached()
    await asMachine(machine.token, '/machines/current/poll')
    await db
      .updateTable('machines')
      .set({ last_seen_at: sql<Date>`now() - make_interval(secs => ${SILENT_FOR_SECONDS + 5})` })
      .where('id', '=', machine.id)
      .execute()

    expect((await seenInSpace()).machines[0]?.presence.state).toBe('gone')
  })

  it('is here again after it comes back, without being approved again', async () => {
    const machine = await attached()
    await asMachine(machine.token, '/machines/current/session', 'DELETE')

    await asMachine(machine.token, '/machines/current/poll')

    expect((await seenInSpace()).machines[0]?.presence.state).toBe('here')
  })
})

describe('taking one away', () => {
  it('stops its credential working', async () => {
    const machine = await attached()

    await app.request(`/spaces/${SLUG}/machines/${machine.id}`, {
      method: 'DELETE',
      headers: { cookie: COOKIE },
    })

    expect((await asMachine(machine.token, '/machines/current/poll')).status).toBe(401)
    expect((await seenInSpace()).machines).toEqual([])
  })

  it('will not take one out of a Space the person is not in', async () => {
    const machine = await attached()

    const answered = await app.request(
      `/spaces/somebody-elses-${RUN.slice(0, 8)}/machines/${machine.id}`,
      { method: 'DELETE', headers: { cookie: COOKIE } },
    )

    expect(answered.status).toBe(404)
    expect((await seenInSpace()).machines).toHaveLength(1)
  })

  it('answers an id that is not an id the way it answers one that names nothing', async () => {
    // It used to reach a uuid column and come back a database error: a 500 for something the
    // caller did. Telling "not a uuid" apart from "not yours" would make the URL a way to find
    // out, which is the same reason a missing Space and one you are not in read alike.
    await attached()

    const answered = await app.request(`/spaces/${SLUG}/machines/not-a-uuid`, {
      method: 'DELETE',
      headers: { cookie: COOKIE },
    })

    expect(answered.status).toBe(404)
    expect(await answered.json()).toMatchObject({ reason: 'unavailable' })
    expect((await seenInSpace()).machines).toHaveLength(1)
  })

  it('needs the Space it is in, not just its id', async () => {
    const machine = await attached()

    // A second Space this person really is in. The id is real and the membership is real, and it
    // still removes nothing, because the machine is not in *that* Space.
    const other = await anotherSpace()

    const answered = await app.request(`/spaces/${other}/machines/${machine.id}`, {
      method: 'DELETE',
      headers: { cookie: COOKIE },
    })

    expect(answered.status).toBe(404)
    expect((await seenInSpace()).machines).toHaveLength(1)
  })
})

describe('looking at a Space', () => {
  it('shows nothing about one this person is not in', async () => {
    await attached()

    const answered = await app.request(`/spaces/somebody-elses-${RUN.slice(0, 8)}/machines`, {
      headers: { cookie: COOKIE },
    })

    expect(answered.status).toBe(404)
  })
})

describe('the two doors do not open to each other', () => {
  it('will not let a machine read the Space it is in', async () => {
    // A machine reports and takes work. Reading a Space is a person's business, and one door for
    // both would be the weaker of the two everywhere.
    const machine = await attached()

    const answered = await app.request(`/spaces/${SLUG}/machines`, {
      headers: { authorization: `Bearer ${machine.token}` },
    })

    expect(answered.status).toBe(401)
  })

  it('will not let a person check in as a machine', async () => {
    await attached()

    const answered = await app.request('/machines/current/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: COOKIE },
      body: JSON.stringify({ found: [] }),
    })

    expect(answered.status).toBe(401)
  })

  it('tells a machine to start over rather than to sign in', async () => {
    // A machine cannot sign in. Handing it a person's recovery would be telling it to do
    // something it has no way to do.
    const answered = await app.request('/machines/current/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer hm_nonsense' },
      body: JSON.stringify({ found: [] }),
    })

    expect(await answered.json()).toEqual({ reason: 'no-machine', recovery: 'start-over' })
  })
})
