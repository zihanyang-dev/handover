import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { normalizeSlug, type Slug } from '@handover/universal'
import { connect, type Database } from '../db/connection.ts'
import { openSession } from '../db/session.ts'
import { createSpace } from '../db/space.ts'
import { arrive } from '../db/user.ts'
import { loadEnv } from '../env.ts'
import { newSessionToken } from '../identity/session.ts'
import { approvalApi } from './approval-api.ts'
import { conversationApi } from './conversation-api.ts'
import { enrolmentApi } from './enrolment-api.ts'
import { machineApi } from './machine-api.ts'
import { SESSION_COOKIE } from './session.ts'

const env = loadEnv()
const db: Database = connect(env)
const enrolments = enrolmentApi({ db, webOrigin: 'http://localhost:5173' }).route(
  '/',
  approvalApi({ db }),
)
const machines = machineApi({ db })
const app = conversationApi({ db })

afterAll(async () => {
  await db.destroy()
})

let RUN = ''
let SLUG = ''
let COOKIE = ''
let MACHINE = { token: '', id: '' }
let USER = ''

beforeEach(async () => {
  RUN = randomUUID()
  const address = `mina-${RUN}@example.com`
  const arrived = await db
    .transaction()
    .execute(async (tx) =>
      arrive(tx, { kind: 'email', subject: address }, { name: null, username: null, address }),
    )

  USER = arrived.userId
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

  MACHINE = await attached()
  await asMachine('/machines/current/poll', 'POST', {
    found: [{ command: 'claude', version: '2.1.231' }],
  })
})

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

async function asMachine(path: string, method = 'POST', json?: unknown) {
  return machines.request(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MACHINE.token}` },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  })
}

/** The machine's own credential, against the routes conversations live on. */
async function machineWrites(path: string, json: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MACHINE.token}` },
    body: JSON.stringify(json),
  })
}

async function asPerson(path: string, method = 'GET', json?: unknown) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  })
}

/** A reading with the moment it was taken replaced, since that is never the same twice. */
function exceptTheClock(reading: unknown) {
  return { ...(reading as Record<string, unknown>), asOf: 'when it was read' }
}

async function opened(): Promise<string> {
  const response = await asPerson(`/spaces/${SLUG}/conversations`, 'POST', {
    machineId: MACHINE.id,
    agentKind: 'claude-code',
  })
  const { id } = (await response.json()) as { id: string }
  return id
}

describe('opening a conversation', () => {
  it('opens one on a machine that has that agent', async () => {
    const response = await asPerson(`/spaces/${SLUG}/conversations`, 'POST', {
      machineId: MACHINE.id,
      agentKind: 'claude-code',
    })

    expect(response.status).toBe(201)
  })

  it('says which of the two went wrong when the agent is not on that machine', async () => {
    // "No such machine" and "that machine has no Codex" send a person to different places.
    const response = await asPerson(`/spaces/${SLUG}/conversations`, 'POST', {
      machineId: MACHINE.id,
      agentKind: 'codex',
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ recovery: 'choose-another-agent' })
  })
})

describe('saying something', () => {
  it('lands once, and says so again if the answer was lost', async () => {
    const conversation = await opened()
    const said = { key: 'turn-1', asked: { text: 'read notes.txt' } }
    const path = `/spaces/${SLUG}/conversations/${conversation}/messages`

    expect((await asPerson(path, 'POST', said)).status).toBe(204)
    expect((await asPerson(path, 'POST', said)).status).toBe(204)

    const read = (await (
      await asPerson(`/spaces/${SLUG}/conversations/${conversation}`)
    ).json()) as {
      messages: readonly unknown[]
    }
    expect(read.messages).toHaveLength(1)
  })

  it('refuses a second question while the first is unanswered', async () => {
    const conversation = await opened()
    const path = `/spaces/${SLUG}/conversations/${conversation}/messages`
    await asPerson(path, 'POST', { key: 'turn-1', asked: { text: 'first' } })

    const response = await asPerson(path, 'POST', { key: 'turn-2', asked: { text: 'second' } })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ recovery: 'wait' })
  })
})

describe('coming back to it', () => {
  it('reads the same on another device, because the record is not in the browser', async () => {
    // The promise a person is actually making when they close a laptop: what was said and done is
    // kept where it happened, not in the tab that watched it happen. A second session is what a
    // second device is — nothing about the first one is carried over.
    const conversation = await opened()
    await asPerson(`/spaces/${SLUG}/conversations/${conversation}/messages`, 'POST', {
      key: 'turn-1',
      asked: { text: 'read notes.txt' },
    })
    await asMachine('/machines/current/poll', 'POST', { found: [] })
    await machineWrites(`/machines/current/conversations/${conversation}/messages`, {
      key: 'turn-1/1',
      message: { role: 'assistant', content: { text: 'it says hello' } },
    })
    await machineWrites(`/machines/current/conversations/${conversation}/messages`, {
      key: 'turn-1/done',
      message: { role: 'activity', content: { activityType: 'done' } },
    })

    const elsewhere = newSessionToken()
    await openSession(db, { user: USER, tokenHash: elsewhere.hash })
    const here = await asPerson(`/spaces/${SLUG}/conversations/${conversation}`)
    const there = await app.request(`/spaces/${SLUG}/conversations/${conversation}`, {
      headers: { cookie: `${SESSION_COOKIE}=${elsewhere.token}` },
    })

    expect(there.status).toBe(200)
    // Everything but the clock, which is when the reading was taken and is the one thing that is
    // supposed to differ between two devices.
    expect(exceptTheClock(await there.json())).toEqual(exceptTheClock(await here.json()))
  })
})

describe('handing the question to the machine', () => {
  it('arrives in the answer to the check-in it was already making', async () => {
    const conversation = await opened()
    await asPerson(`/spaces/${SLUG}/conversations/${conversation}/messages`, 'POST', {
      key: 'turn-1',
      asked: { text: 'read notes.txt' },
    })

    const checkedIn = await asMachine('/machines/current/poll', 'POST', { found: [] })

    expect(await checkedIn.json()).toMatchObject({
      asking: {
        conversationId: conversation,
        agentKind: 'claude-code',
        asked: { text: 'read notes.txt' },
      },
    })
  })

  it('carries nothing when there is nothing to answer', async () => {
    const checkedIn = await asMachine('/machines/current/poll', 'POST', { found: [] })

    expect(await checkedIn.json()).not.toHaveProperty('asking')
  })
})

describe('a machine that has just started', () => {
  it('has what it left open closed as unknown', async () => {
    // Killing the process that drives an agent does not kill the agent. Whatever it went on to do
    // happened with nobody watching, and no answer about it can be had from here.
    const conversation = await opened()
    await asPerson(`/spaces/${SLUG}/conversations/${conversation}/messages`, 'POST', {
      key: 'turn-1',
      asked: { text: 'take your time' },
    })
    // The machine takes it the way it really does — by reporting — and then says one thing before
    // whatever was driving it went away.
    await asMachine('/machines/current/poll', 'POST', { found: [] })
    await machineWrites(`/machines/current/conversations/${conversation}/messages`, {
      key: 'turn-1/1',
      message: { role: 'assistant', content: { text: 'on it' } },
    })

    await asMachine('/machines/current/poll', 'POST', { found: [], restarted: true })

    const read = (await (
      await asPerson(`/spaces/${SLUG}/conversations/${conversation}`)
    ).json()) as { working: { state: string }; messages: readonly { content: unknown }[] }
    expect(read.messages.at(-1)?.content).toEqual({ activityType: 'unknown' })
    expect(read.working).toEqual({ state: 'idle' })
  })

  it('leaves an unanswered question waiting, because no agent ever saw it', async () => {
    const conversation = await opened()
    await asPerson(`/spaces/${SLUG}/conversations/${conversation}/messages`, 'POST', {
      key: 'turn-1',
      asked: { text: 'hello' },
    })

    const checkedIn = await asMachine('/machines/current/poll', 'POST', {
      found: [],
      restarted: true,
    })

    expect(await checkedIn.json()).toMatchObject({ asking: { conversationId: conversation } })
  })
})

describe('the two doors', () => {
  it('will not let a person write what only a machine may write', async () => {
    const conversation = await opened()

    const response = await asPerson(
      `/machines/current/conversations/${conversation}/messages`,
      'POST',
      {
        key: 'turn-1/said',
        message: { role: 'assistant', content: { text: 'I am not a machine' } },
      },
    )

    expect(response.status).toBe(401)
  })

  it('will not let a machine open a conversation', async () => {
    const response = await app.request(`/spaces/${SLUG}/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${MACHINE.token}` },
      body: JSON.stringify({ machineId: MACHINE.id, agentKind: 'claude-code' }),
    })

    expect(response.status).toBe(401)
  })
})
