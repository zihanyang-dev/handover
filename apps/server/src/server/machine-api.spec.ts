/**
 * Somebody else in this Space, with a laptop of their own.
 *
 * The membership is written here rather than joined through the product, because nothing shipped
 * yet lets anybody join a Space — and what these tests are about is what a second member sees.
 */

import { randomUUID } from 'node:crypto'
import { normalizeSlug, type Slug } from '@handover/universal'
import { sql } from 'kysely'
import { pino } from 'pino'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { connect, type Database } from '../db/connection.ts'
import { openConversation, sayTo } from '../db/conversation.ts'
import { openSession } from '../db/session.ts'
import { createSpace } from '../db/space.ts'
import { arrive } from '../db/user.ts'
import { listenForWaking } from '../db/waking.ts'
import { loadEnv } from '../env.ts'
import { newSessionToken } from '../identity/session.ts'
import { LOG_OPTIONS } from '../log.ts'
import { SILENT_FOR_SECONDS } from '../machine/presence.ts'
import { waitingRoom, type Waiting } from '../machine/waiting.ts'
import { enrolmentApi } from './enrolment-api.ts'
import { machineApi } from './machine-api.ts'
import { mounted } from './route.ts'
import { SESSION_COOKIE } from './session.ts'

const env = loadEnv()
const db: Database = connect(env)

/** A log nobody reads: what these tests are about is what comes back, not what was written down. */
const silent = pino(LOG_OPTIONS, { write: () => undefined })
const enrolments = mounted(enrolmentApi({ db, webOrigin: 'http://localhost:5173' }))
/** Zero, so every test below answers at once. The holding itself has its own tests, at the end. */
const app = mounted(machineApi({ db, waiting: waitingRoom(0) }))

afterAll(async () => {
  await db.destroy()
})

let RUN = ''
let SLUG = ''
let COOKIE = ''
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
  SPACE = made.space.id
})

/** A machine that got in, and the credential it holds. Whoever answered it owns it. */
async function attached(
  machineName = 'mina-mbp',
  cookie = COOKIE,
): Promise<{ token: string; id: string }> {
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
    headers: { 'content-type': 'application/json', cookie },
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

/** A conversation on this machine, and something said into it — the only things a machine waits for. */
async function conversationOn(machine: { id: string; token: string }): Promise<string> {
  // Reported first: a conversation can only be opened with an agent the machine says it has.
  await asMachine(machine.token, '/machines/current/poll', 'POST', {
    found: [{ command: 'claude', version: '2.1.4' }],
  })

  const opened = await openConversation(db, {
    spaceId: SPACE,
    machineId: machine.id,
    agentKind: 'claude-code',
  })
  if (opened.kind !== 'opened') throw new Error('the fixture could not open a conversation')

  return opened.conversationId
}

async function said(conversationId: string, text: string): Promise<void> {
  const landed = await sayTo(
    db,
    { conversationId, spaceId: SPACE, key: `${conversationId}/${text}`, saidBy: PERSON },
    { text },
  )
  if (landed.kind !== 'said') throw new Error(`the fixture could not say anything: ${landed.kind}`)
}

type Seen = {
  machines: { id: string; name: string; presence: { state: string }; agents: unknown[] }[]
}

async function seenInSpace(): Promise<Seen> {
  const answered = await app.request(`/spaces/${SLUG}/machines`, { headers: { cookie: COOKIE } })
  return (await answered.json()) as Seen
}

/** Somebody else, signed in. Their session reaches their own things and nothing of yours. */
async function signedInStranger(): Promise<{ cookie: string; userId: string }> {
  const address = `rui-${RUN}@example.com`
  const arrived = await db
    .transaction()
    .execute(async (tx) =>
      arrive(tx, { kind: 'email', subject: address }, { name: null, username: null, address }),
    )

  const token = newSessionToken()
  await openSession(db, { user: arrived.userId, tokenHash: token.hash })
  return { cookie: `${SESSION_COOKIE}=${token.token}`, userId: arrived.userId }
}

async function alsoHere(): Promise<{ cookie: string; userId: string }> {
  const stranger = await signedInStranger()
  await db
    .insertInto('memberships')
    .values({ space_id: SPACE, user_id: stranger.userId, request_key: `joined-${RUN}` })
    .execute()

  return stranger
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

describe('disconnecting one', () => {
  it('stops its credential working', async () => {
    const machine = await attached()

    await app.request(`/me/machines/${machine.id}`, {
      method: 'DELETE',
      headers: { cookie: COOKIE },
    })

    expect((await asMachine(machine.token, '/machines/current/poll')).status).toBe(401)
    expect((await seenInSpace()).machines).toEqual([])
  })

  it('answers an id that is not an id the way it answers one that names nothing', async () => {
    // It used to reach a uuid column and come back a database error: a 500 for something the
    // caller did. Telling "not a uuid" apart from "not yours" would make the URL a way to find
    // out, which is the same reason a missing Space and one you are not in read alike.
    await attached()

    const answered = await app.request('/me/machines/not-a-uuid', {
      method: 'DELETE',
      headers: { cookie: COOKIE },
    })

    expect(answered.status).toBe(404)
    expect(await answered.json()).toMatchObject({ reason: 'unavailable' })
    expect((await seenInSpace()).machines).toHaveLength(1)
  })

  it('is only its owner who can, whoever else can see it', async () => {
    // Somebody sharing a Space with you can reach your laptop — that is what a Space is for — but
    // it is still your laptop. Being able to disconnect it would be being able to take it.
    const machine = await attached()
    const stranger = await alsoHere()

    const answered = await app.request(`/me/machines/${machine.id}`, {
      method: 'DELETE',
      headers: { cookie: stranger.cookie },
    })

    expect(answered.status).toBe(404)
    expect((await seenInSpace()).machines).toHaveLength(1)
  })
})

describe('which Spaces can reach it', () => {
  it('is every Space its owner is in, without connecting it again', async () => {
    // The whole of it. A laptop belongs to a person, and that person is in as many Spaces as
    // they are in — so a second Space is not a second enrolment.
    const machine = await attached()
    const other = await anotherSpace()

    const answered = await app.request(`/spaces/${other}/machines`, { headers: { cookie: COOKIE } })

    expect(answered.status).toBe(200)
    expect(((await answered.json()) as { machines: { id: string }[] }).machines).toMatchObject([
      { id: machine.id },
    ])
  })

  it('says whose each one is, because one of them is somebody else\u2019s laptop', async () => {
    // What an agent does on a machine happens in its owner's files. Two rows called `mbp` with
    // nothing else on them would be a page that cannot say which one that is.
    await attached()
    const stranger = await alsoHere()
    await attached('rui-mbp', stranger.cookie)

    const answered = await app.request(`/spaces/${SLUG}/machines`, { headers: { cookie: COOKIE } })
    const seen = (await answered.json()) as {
      machines: { name: string; ownerName: string; yours: boolean }[]
    }

    expect(seen.machines).toMatchObject([
      { name: 'mina-mbp', yours: true },
      { name: 'rui-mbp', yours: false, ownerName: `rui-${RUN}@example.com` },
    ])
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

describe('holding a machine question instead of answering "nothing"', () => {
  /** Long enough that nothing below can pass by timing out, short enough to abandon. */
  const NEVER = 30

  /** An app of its own, because what is being tested is how long this one holds. */
  const holding = (room: Waiting) => mounted(machineApi({ db, waiting: room }))

  it('answers at once when there is already something to take', async () => {
    // The hold is for when there is nothing. Anything else would make every turn wait out a hold
    // that had no reason to start.
    const room = waitingRoom(NEVER)
    const machine = await attached()
    const conversation = await conversationOn(machine)
    await said(conversation, 'read notes.txt')

    const answered = await holding(room).request('/machines/current/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${machine.token}` },
      body: JSON.stringify({ found: [] }),
    })

    expect(await answered.json()).toMatchObject({ asking: { conversationId: conversation } })
  })

  it('answers the moment somebody says something, rather than on the next report', async () => {
    // The whole point, and the whole path: the message is written on this connection, Postgres
    // carries the waking to a connection of its own, and the request being held here answers.
    // That last hop is also what makes this work between two instances — the listener is not the
    // pool that wrote, any more than another instance would be.
    const room = waitingRoom(NEVER)
    const waking = listenForWaking(env, silent, (machineId) => {
      room.wake(machineId)
    })
    await waking.listening

    try {
      const machine = await attached('waiting-mbp')
      const conversation = await conversationOn(machine)

      const asking = holding(room).request('/machines/current/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${machine.token}` },
        body: JSON.stringify({ found: [] }),
      })
      // Said once the question is already being held, which is the only order that tests anything.
      await new Promise((soon) => setTimeout(soon, 50))
      await said(conversation, 'read notes.txt')

      expect(await (await asking).json()).toMatchObject({
        asking: { conversationId: conversation },
      })
    } finally {
      await waking.stop()
    }
  })

  it('says there is nothing, once the hold is over', async () => {
    const room = waitingRoom(0.05)
    const machine = await attached('quiet-mbp')

    const answered = await holding(room).request('/machines/current/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${machine.token}` },
      body: JSON.stringify({ found: [] }),
    })

    expect(await answered.json()).not.toHaveProperty('asking')
  })

  it('lets go of every held question when this instance is stopping', async () => {
    // Draining them would mean waiting out the hold, and a deploy that takes that long looks
    // broken. They are answered, and their machines ask again wherever they land.
    const room = waitingRoom(NEVER)
    const machine = await attached('leaving-mbp')

    const asking = holding(room).request('/machines/current/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${machine.token}` },
      body: JSON.stringify({ found: [] }),
    })
    await new Promise((soon) => setTimeout(soon, 50))
    room.wakeEveryone()

    expect((await asking).status).toBe(200)
  })
})

describe('a machine that is already answering something', () => {
  it('is not handed a second question, because it would drop it on the floor', async () => {
    // A person can open two conversations on one machine. The machine answers one at a time and
    // ignores anything else it is handed — while the server has already written down that this
    // question was taken. Nobody ever runs it, and the page shows it working until the machine
    // restarts, which is the one outcome `unknown` exists to make rare.
    //
    // Whether it is busy is read from the ledger, not asked of the machine: a turn it has taken
    // and not ended is one it is on, and that stays true while it is winding down.
    const machine = await attached('busy-mbp')
    const one = await conversationOn(machine)
    const two = await conversationOn(machine)
    await said(one, 'the first thing')
    await said(two, 'the second thing')

    await asMachine(machine.token, '/machines/current/poll')
    const next = await asMachine(machine.token, '/machines/current/poll')

    expect(await next.json()).not.toHaveProperty('asking')
  })
})
