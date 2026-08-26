import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { connect, type Database } from '../db/connection.ts'
import { createSpace } from '../db/space.ts'
import { openSession } from '../db/session.ts'
import { arrive } from '../db/user.ts'
import { loadEnv } from '../env.ts'
import { newSessionToken } from '../identity/session.ts'
import { hashSecret } from '../machine/secret.ts'
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

async function collect(
  secret: string,
  machineName = 'mina-mbp',
  // The credential the machine is bringing with it. Minted by the machine, so asking twice with
  // the same one is the same machine asking twice.
  token = `hm_${randomUUID()}`,
): Promise<{ kind: string; machineId?: string }> {
  const answered = await app.request('/enrolments/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, machineName, token }),
  })
  return (await answered.json()) as { kind: string; machineId?: string }
}

/** A key somebody made for themselves: an enrolment that arrives approved. */
async function makeKey(): Promise<string> {
  const made = await as('/me/machine-keys', 'POST')
  return ((await made.json()) as { key: string }).key
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

    await as('/me/machines', 'POST', { userCode: asked.userCode })

    expect(await collect(asked.secret)).toMatchObject({ kind: 'granted' })
  })

  it('answers a machine that never heard the first answer with the same one', async () => {
    // The whole reason a machine mints its own credential. Generated on this side, the plaintext
    // existed once — in one response — and a machine that never received it could only ask again
    // and be told the enrolment was spent, leaving a machine in the Space nobody could recover.
    const asked = await ask()
    await as('/me/machines', 'POST', { userCode: asked.userCode })
    const token = `hm_${randomUUID()}`
    const first = await collect(asked.secret, 'mina-mbp', token)

    const again = await collect(asked.secret, 'mina-mbp', token)

    expect(again).toEqual(first)
  })

  it('tells a different machine the enrolment is spent, however it asks', async () => {
    // A single-use key really can be taken by somebody else, and that is worth being told rather
    // than being handed a second credential for a Space that agreed to one machine.
    const asked = await ask()
    await as('/me/machines', 'POST', { userCode: asked.userCode })
    await collect(asked.secret)

    expect(await collect(asked.secret)).toEqual({ kind: 'spent' })
  })

  it('needs nobody to pick a Space, because a machine is not in one', async () => {
    // What somebody agrees to is that the machine is theirs. Where it can be reached from
    // follows from where they are a member, and is not a decision anybody makes here.
    const asked = await ask()

    const answered = await as('/me/machines', 'POST', { userCode: asked.userCode })

    expect(answered.status).toBe(204)
    expect(await collect(asked.secret)).toMatchObject({ kind: 'granted' })
  })

  it('stays refused once somebody says no', async () => {
    const asked = await ask()

    await as(`/enrolments/${asked.userCode}/refuse`, 'POST')

    expect(await collect(asked.secret)).toEqual({ kind: 'refused' })
    expect((await as('/me/machines', 'POST', { userCode: asked.userCode })).status).toBe(404)
  })

  it('approves nothing when the code is not a code, even in a Space you are in', async () => {
    const answered = await as('/me/machines', 'POST', { userCode: 'hello-there' })

    expect(answered.status).toBe(404)
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

    const answered = await app.request('/me/machines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userCode: asked.userCode }),
    })

    expect(answered.status).toBe(401)
    expect(await collect(asked.secret)).toEqual({ kind: 'waiting' })
  })
})

describe('a key for a machine with no browser', () => {
  it('lets a machine straight in, because generating it was the approving', async () => {
    // Not a second mechanism: the same collect, on a row that arrived with the decision on it.
    const key = await makeKey()

    expect(await collect(key, 'build-server-1')).toMatchObject({ kind: 'granted' })
  })

  it('takes the name from the machine, because nobody named it when the key was made', async () => {
    const key = await makeKey()

    await collect(key, `build-server-${RUN.slice(0, 8)}`)

    const named = await db
      .selectFrom('machines')
      .select('name')
      .where('name', '=', `build-server-${RUN.slice(0, 8)}`)
      .executeTakeFirst()

    expect(named).toBeDefined()
  })

  it('works once, and says so plainly the second time', async () => {
    // A key pasted onto ten servers admits one. The other nine are told somebody used it, not
    // that it never existed.
    const key = await makeKey()
    await collect(key, 'build-server-1')

    expect(await collect(key, 'build-server-2')).toEqual({ kind: 'spent' })
  })

  it('is not made by nobody', async () => {
    const answered = await app.request('/me/machine-keys', { method: 'POST' })

    expect(answered.status).toBe(401)
  })

  it('carries no code, because a code nobody will read can only leak', async () => {
    const key = await makeKey()

    const made = await db
      .selectFrom('enrolments')
      .select(['user_code', 'approved_at'])
      .where('secret_hash', '=', hashSecret(key))
      .executeTakeFirstOrThrow()

    expect(made.user_code).toBeNull()
    expect(made.approved_at).not.toBeNull()
  })
})
