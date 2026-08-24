import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { connect, type Database } from '../db/connection.ts'
import { createSpace } from '../db/space.ts'
import { openSession } from '../db/session.ts'
import { arrive } from '../db/user.ts'
import { loadEnv } from '../env.ts'
import { newSessionToken } from '../identity/session.ts'
import { approvalApi } from './approval-api.ts'
import { enrolmentApi } from './enrolment-api.ts'
import { SESSION_COOKIE } from './session.ts'
import { normalizeSlug, type Slug } from '@handover/universal'

const env = loadEnv()
const db: Database = connect(env)
const WEB = 'http://localhost:5173'
/** Both halves, mounted as the app mounts them: one journey, two audiences. */
const app = enrolmentApi({ db, webOrigin: WEB }).route('/', approvalApi({ db }))

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
  await openSession(db, arrived.userId, token.hash)
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

type Asked = { secret: string; userCode: string; verifyUrl: string; verifyUrlComplete: string }

async function ask(machineName = 'mina-mbp'): Promise<Asked> {
  const answered = await app.request('/enrolments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ machineName }),
  })
  return (await answered.json()) as Asked
}

async function as(path: string, method = 'GET', json?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  })
}

async function collect(secret: string): Promise<{ kind: string; token?: string }> {
  const answered = await app.request('/enrolments/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret }),
  })
  return (await answered.json()) as { kind: string; token?: string }
}

describe('asking to come in', () => {
  it('needs no session, because a machine nobody approved has no identity to prove', async () => {
    const answered = await app.request('/enrolments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineName: 'mina-mbp' }),
    })

    expect(answered.status).toBe(201)
  })

  it('gives a clean address and one with the code already in it', async () => {
    const asked = await ask()

    expect(asked.verifyUrl).toBe(`${WEB}/connect`)
    expect(asked.verifyUrlComplete).toBe(`${WEB}/connect/${asked.userCode}`)
  })

  it('hands the secret back once, with the code', async () => {
    // The machine never has to store it before it is worth anything, and never has to be told
    // twice. It is not in the table either — only its hash is.
    expect((await ask()).secret).toMatch(/^hk_/u)
  })

  it('waits, which is the ordinary answer and not a failure', async () => {
    expect(await collect((await ask()).secret)).toEqual({ kind: 'waiting' })
  })
})

describe('answering', () => {
  it('shows which machine is asking, and does not name a Space', async () => {
    const asked = await ask('rui-desktop')

    const waiting = (await (await as(`/enrolments/${asked.userCode}`)).json()) as {
      machineName: string
    }

    expect(waiting.machineName).toBe('rui-desktop')
    expect(Object.keys(waiting)).not.toContain('spaceName')
  })

  it('takes a code typed the way somebody read it', async () => {
    const asked = await ask()

    const answered = await as(`/enrolments/${asked.userCode.toLowerCase().replace('-', '')}`)

    expect(answered.status).toBe(200)
  })

  it('lets the machine in once somebody says yes', async () => {
    const asked = await ask()

    await as(`/spaces/${SLUG}/enrolments/${asked.userCode}/approve`, 'POST')

    expect(await collect(asked.secret)).toMatchObject({ kind: 'granted' })
  })

  it('hands over a credential that is not the enrolment secret', async () => {
    // Two secrets, two lives: a key pasted onto ten servers must not be the credential any one of
    // them ends up holding.
    const asked = await ask()
    await as(`/spaces/${SLUG}/enrolments/${asked.userCode}/approve`, 'POST')

    const collected = await collect(asked.secret)

    expect(collected.token).toMatch(/^hm_/u)
    expect(collected.token).not.toBe(asked.secret)
  })

  it('refuses to approve into a Space the person is not in', async () => {
    // The same answer a missing Space gets. Otherwise a code plus a guessed slug would say which
    // Spaces exist.
    const asked = await ask()

    const answered = await as(
      `/spaces/not-mine-${RUN.slice(0, 8)}/enrolments/${asked.userCode}/approve`,
      'POST',
    )

    expect(answered.status).toBe(404)
    expect(await collect(asked.secret)).toEqual({ kind: 'waiting' })
  })

  it('stays refused once somebody says no', async () => {
    const asked = await ask()

    await as(`/enrolments/${asked.userCode}/refuse`, 'POST')

    expect(await collect(asked.secret)).toEqual({ kind: 'refused' })
    expect((await as(`/spaces/${SLUG}/enrolments/${asked.userCode}/approve`, 'POST')).status).toBe(
      404,
    )
  })

  it('approves nothing when the code is not a code, even in a Space you are in', async () => {
    expect((await as(`/spaces/${SLUG}/enrolments/hello-there/approve`, 'POST')).status).toBe(404)
  })

  it('refuses nothing when the code is not a code, rather than pretending it did', async () => {
    expect((await as('/enrolments/hello-there/refuse', 'POST')).status).toBe(404)
  })

  it('says nothing is waiting for a code nobody asked under', async () => {
    expect((await as('/enrolments/WDJB-MJHT')).status).toBe(404)
  })

  it('answers a code that is not a code the same way', async () => {
    // Typing nonsense and typing an expired code are the same situation for the person: start
    // again from the terminal.
    expect((await as('/enrolments/hello-there')).status).toBe(404)
  })
})

describe('without a session', () => {
  it('will not show what is waiting', async () => {
    const asked = await ask()

    const answered = await app.request(`/enrolments/${asked.userCode}`)

    expect(answered.status).toBe(401)
  })

  it('will not approve', async () => {
    const asked = await ask()

    const answered = await app.request(`/spaces/${SLUG}/enrolments/${asked.userCode}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    expect(answered.status).toBe(401)
    expect(await collect(asked.secret)).toEqual({ kind: 'waiting' })
  })
})
