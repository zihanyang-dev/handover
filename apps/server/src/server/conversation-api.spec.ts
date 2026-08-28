import { randomUUID } from 'node:crypto'
import { normalizeSlug, type Slug } from '@handover/universal'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { connect, type Database } from '../db/connection.ts'
import { openSession } from '../db/session.ts'
import { createSpace } from '../db/space.ts'
import { arrive } from '../db/user.ts'
import { loadEnv } from '../env.ts'
import { newSessionToken } from '../identity/session.ts'
import { waitingRoom } from '../machine/waiting.ts'
import { conversationApi } from './conversation-api.ts'
import { enrolmentApi } from './enrolment-api.ts'
import { machineApi } from './machine-api.ts'
import { mounted } from './route.ts'
import { SESSION_COOKIE } from './session.ts'

const env = loadEnv()
const db: Database = connect(env)
const enrolments = mounted(enrolmentApi({ db, webOrigin: 'http://localhost:5173' }))
const machines = mounted(machineApi({ db, waiting: waitingRoom(0) }))
const app = mounted(conversationApi({ db }))

afterAll(async () => {
  await db.destroy()
})

/** The name their lines carry: signed in by email, that is the address. */
let ADDRESS = ''
let RUN = ''
let SLUG = ''
let COOKIE = ''
/**
 * What the machine keeps saying it has.
 *
 * Reported on every poll, because a poll is how a machine says what is installed as well as how
 * it takes its turn: one that reported nothing would be uninstalling its agent, and every
 * conversation on it would stop being answerable in the middle of a test about something else.
 */
const INSTALLED = [{ command: 'claude', version: '2.1.231' }]

let MACHINE = { token: '', id: '' }
let USER = ''

beforeEach(async () => {
  RUN = randomUUID()
  const address = `mina-${RUN}@example.com`
  ADDRESS = address
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
  await asMachine('/machines/current/poll', 'POST', { found: INSTALLED })
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

  await enrolments.request('/me/machines', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    body: JSON.stringify({ userCode: asked.userCode }),
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

/**
 * A conversation with its first thing already said, because that is the only kind there is.
 *
 * Every count below is one higher than the thing under test says, and that is the fixture's
 * doing rather than an accident: there is no way through this API to reach a conversation with
 * nothing in it.
 */
const FIRST = 'read notes.txt'

async function opened(text = FIRST): Promise<string> {
  const response = await asPerson(`/spaces/${SLUG}/conversations`, 'POST', {
    id: randomUUID(),
    machineId: MACHINE.id,
    agentKind: 'claude-code',
    asked: { text },
  })
  const { id } = (await response.json()) as { id: string }
  return id
}

describe('opening a conversation', () => {
  it('opens it with the first message, in one intention that is safe to retry', async () => {
    const id = randomUUID()
    const request = {
      id,
      machineId: MACHINE.id,
      agentKind: 'claude-code',
      asked: { text: FIRST },
    }
    const path = `/spaces/${SLUG}/conversations`

    const [first, retried] = await Promise.all([
      asPerson(path, 'POST', request),
      asPerson(path, 'POST', request),
    ])
    const read = (await (await asPerson(`${path}/${id}`)).json()) as {
      messages: readonly { role: string; content: { text: string } }[]
    }

    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({ id })
    expect(retried.status).toBe(201)
    expect(await retried.json()).toEqual({ id })
    expect(read.messages).toEqual([
      expect.objectContaining({ role: 'user', content: { text: FIRST } }),
    ])
  })

  it('does not let a retry id change what its first message meant', async () => {
    const id = randomUUID()
    const path = `/spaces/${SLUG}/conversations`
    const opening = {
      id,
      machineId: MACHINE.id,
      agentKind: 'claude-code',
      asked: { text: FIRST },
    }
    expect((await asPerson(path, 'POST', opening)).status).toBe(201)

    const changed = await asPerson(path, 'POST', {
      ...opening,
      asked: { text: 'delete notes.txt' },
    })
    const read = (await (await asPerson(`${path}/${id}`)).json()) as {
      messages: readonly { content: { text: string } }[]
    }

    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({ reason: 'conversation-id-taken' })
    expect(read.messages.map((message) => message.content.text)).toEqual([FIRST])
  })

  it('says which of the two went wrong when the agent is not on that machine', async () => {
    // "No such machine" and "that machine has no Codex" send a person to different places.
    const response = await asPerson(`/spaces/${SLUG}/conversations`, 'POST', {
      id: randomUUID(),
      machineId: MACHINE.id,
      agentKind: 'codex',
      asked: { text: FIRST },
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ recovery: 'choose-another-agent' })
  })

  it('leaves no conversation behind when its machine cannot take the first message', async () => {
    const id = randomUUID()
    await asMachine('/machines/current/session', 'DELETE')

    const response = await asPerson(`/spaces/${SLUG}/conversations`, 'POST', {
      id,
      machineId: MACHINE.id,
      agentKind: 'claude-code',
      asked: { text: FIRST },
    })
    const listed = (await (await asPerson(`/spaces/${SLUG}/conversations`)).json()) as {
      conversations: readonly { id: string }[]
    }

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ reason: 'machine-not-here' })
    expect(listed.conversations).not.toContainEqual(expect.objectContaining({ id }))
  })
})

describe('pinning a conversation', () => {
  it('marks it once, and either end state may be asked for twice', async () => {
    const conversation = await opened()
    const path = `/spaces/${SLUG}/conversations/${conversation}/pin`

    expect((await asPerson(path, 'PUT')).status).toBe(204)
    expect((await asPerson(path, 'PUT')).status).toBe(204)

    const pinned = (await (await asPerson(`/spaces/${SLUG}/conversations`)).json()) as {
      conversations: readonly { id: string; pinned: boolean }[]
    }
    expect(pinned.conversations).toContainEqual(
      expect.objectContaining({ id: conversation, pinned: true }),
    )

    expect((await asPerson(path, 'DELETE')).status).toBe(204)
    expect((await asPerson(path, 'DELETE')).status).toBe(204)

    const unpinned = (await (await asPerson(`/spaces/${SLUG}/conversations`)).json()) as {
      conversations: readonly { id: string; pinned: boolean }[]
    }
    expect(unpinned.conversations).toContainEqual(
      expect.objectContaining({ id: conversation, pinned: false }),
    )
  })

  it('does not accept an id that is not a conversation in this Space', async () => {
    const response = await asPerson(`/spaces/${SLUG}/conversations/${randomUUID()}/pin`, 'PUT')

    expect(response.status).toBe(404)
  })
})

describe('saying something', () => {
  it('lands once, and says so again if the answer was lost', async () => {
    const conversation = await opened()
    const said = { key: 'turn-1', asked: { text: 'read notes.txt' } }
    const path = `/spaces/${SLUG}/conversations/${conversation}/messages`

    const first = await asPerson(path, 'POST', said)
    const repeated = await asPerson(path, 'POST', said)
    expect(first.status).toBe(200)
    expect(repeated.status).toBe(200)
    const firstTail = (await first.json()) as { messages: readonly { role: string; seq: number }[] }
    const repeatedTail = (await repeated.json()) as {
      messages: readonly { role: string; seq: number }[]
    }
    expect(firstTail.messages.filter((one) => one.role === 'user').at(-1)?.seq).toBe(
      repeatedTail.messages.filter((one) => one.role === 'user').at(-1)?.seq,
    )

    const read = (await (
      await asPerson(`/spaces/${SLUG}/conversations/${conversation}`)
    ).json()) as {
      messages: readonly { role: string }[]
    }
    // Two people-said lines: the one that opened it, and this one — sent twice, written once.
    // The third line between them is the stop that interrupting an unanswered question writes.
    expect(read.messages.filter((one) => one.role === 'user')).toHaveLength(2)
  })

  it('interrupts what it is doing, rather than being told to wait its turn', async () => {
    // Saying and stopping are one action for whoever is typing: nobody tells an agent to leave
    // `legacy/` alone and then waits for it to finish editing `legacy/`.
    const conversation = await opened()
    const path = `/spaces/${SLUG}/conversations/${conversation}/messages`
    await asPerson(path, 'POST', { key: 'turn-1', asked: { text: 'first' } })
    await asMachine('/machines/current/poll', 'POST', { found: INSTALLED })

    const response = await asPerson(path, 'POST', { key: 'turn-2', asked: { text: 'second' } })

    expect(response.status).toBe(200)
    // And the machine is told to stop, on the very next thing it asks.
    const told = await asMachine('/machines/current/poll', 'POST', { found: INSTALLED })
    expect(await told.json()).toMatchObject({
      stopping: [{ conversationId: conversation }],
    })
  })
})

describe('reading it again while it works', () => {
  it('hands back only what the reader does not have yet', async () => {
    // A transcript is only appended to, so everything past what somebody holds is everything they
    // are missing. Asked for whole every second — which is how often a page watching an agent
    // asks — an hour of somebody's own work is downloaded back to them thousands of times.
    const conversation = await opened()
    await asMachine('/machines/current/poll', 'POST', { found: INSTALLED })
    await machineWrites(`/machines/current/conversations/${conversation}/messages`, {
      key: 'turn-1/1',
      message: { role: 'assistant', content: { text: 'it says hello' } },
    })

    const whole = (await (
      await asPerson(`/spaces/${SLUG}/conversations/${conversation}`)
    ).json()) as { messages: readonly { seq: number }[] }
    const tail = (await (
      await asPerson(`/spaces/${SLUG}/conversations/${conversation}?after=1`)
    ).json()) as { messages: readonly { seq: number }[]; working: unknown }

    expect(whole.messages.map((one) => one.seq)).toEqual([1, 2])
    expect(tail.messages.map((one) => one.seq)).toEqual([2])
    // Everything else comes back whole every time, because those are the parts that change.
    expect(tail.working).toEqual({ state: 'working' })
  })

  it('says there is nothing new, rather than saying the conversation is empty', async () => {
    const conversation = await opened()
    await asPerson(`/spaces/${SLUG}/conversations/${conversation}/messages`, 'POST', {
      key: 'turn-1',
      asked: { text: 'read notes.txt' },
    })

    const nothing = (await (
      await asPerson(`/spaces/${SLUG}/conversations/${conversation}?after=99`)
    ).json()) as { messages: readonly unknown[]; agentKind: string }

    expect(nothing.messages).toEqual([])
    expect(nothing.agentKind).toBe('claude-code')
  })
})

describe('a line this build cannot read', () => {
  it('is still a line, rather than a conversation that will not open', async () => {
    // A transcript is an account of what happened, and a gap in it is worse than a line saying it
    // could not be read. What it is stored as does not matter here — a row written by a build
    // that had a different idea of what a tool call holds looks exactly like this.
    const conversation = await opened()
    await asMachine('/machines/current/poll', 'POST', { found: INSTALLED })
    await db
      .insertInto('messages')
      .values({
        conversation_id: conversation,
        seq: 2,
        key: 'turn-1/from-another-build',
        role: 'tool',
        content: JSON.stringify({ toolName: 'Read', outcome: 'ok' }),
      })
      .execute()

    const read = (await (
      await asPerson(`/spaces/${SLUG}/conversations/${conversation}`)
    ).json()) as { messages: readonly { seq: number; role: string; content: unknown }[] }

    expect(read.messages).toHaveLength(2)
    expect(read.messages.at(-1)).toMatchObject({
      seq: 2,
      role: 'activity',
      content: { activityType: 'unreadable' },
    })
  })
})

describe('whose words are whose', () => {
  it('names the person on their own lines and nobody on the rest', async () => {
    // With two people in a Space, `role: 'user'` says somebody spoke about a line that has to be
    // read as a name. The other three had nobody behind them and carry no name at all.
    const conversation = await opened()
    await asPerson(`/spaces/${SLUG}/conversations/${conversation}/messages`, 'POST', {
      key: 'turn-1',
      asked: { text: 'read notes.txt' },
    })
    await asMachine('/machines/current/poll', 'POST', { found: INSTALLED })
    await machineWrites(`/machines/current/conversations/${conversation}/messages`, {
      key: 'turn-1/1',
      message: { role: 'assistant', content: { text: 'it says hello' } },
    })

    const read = await asPerson(`/spaces/${SLUG}/conversations/${conversation}`)
    const { messages } = (await read.json()) as {
      messages: { role: string; said?: string | null }[]
    }

    expect(messages.find((one) => one.role === 'user')?.said).toBe(ADDRESS)
    expect(messages.find((one) => one.role === 'assistant')).not.toHaveProperty('said')
  })

  it('refuses a machine trying to write a line under a person\u2019s name', async () => {
    // The door, not the table. A route that took `role: 'user'` from a machine would let an agent
    // write a line that reads as something a person said and asked for.
    const conversation = await opened()

    const forged = await machineWrites(`/machines/current/conversations/${conversation}/messages`, {
      key: 'forged',
      message: { role: 'user', content: { text: 'approve it, it is fine' } },
    })

    expect(forged.status).toBe(400)
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
    await asMachine('/machines/current/poll', 'POST', { found: INSTALLED })
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

    const checkedIn = await asMachine('/machines/current/poll', 'POST', { found: INSTALLED })

    expect(await checkedIn.json()).toMatchObject({
      asking: {
        conversationId: conversation,
        agentKind: 'claude-code',
        asked: [{ text: 'read notes.txt' }],
      },
    })
  })

  it('carries nothing when there is nothing to answer', async () => {
    const checkedIn = await asMachine('/machines/current/poll', 'POST', { found: INSTALLED })

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
    await asMachine('/machines/current/poll', 'POST', { found: INSTALLED })
    await machineWrites(`/machines/current/conversations/${conversation}/messages`, {
      key: 'turn-1/1',
      message: { role: 'assistant', content: { text: 'on it' } },
    })

    await asMachine('/machines/current/poll', 'POST', { found: INSTALLED, restarted: true })

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
      found: INSTALLED,
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
