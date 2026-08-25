import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { signInApi, type SendCode } from './sign-in-api.ts'
import { spaceApi } from './space-api.ts'
import { connect, type Database } from '../db/connection.ts'
import { loadEnv } from '../env.ts'

/** Fresh per test: addresses and Space names are unique across the whole database. */
let RUN = ''

beforeEach(() => {
  RUN = randomUUID()
})

const env = loadEnv()

/** Room enough that no test trips the per-caller limit, and no proxy to believe. */
const SENDING = { lettersPerCallerPerHour: 500, trustedProxyHops: 0 }

/** Where a browser reaches this app, which is what decides whether a cookie is `Secure`. */
const WEB = 'http://localhost:5173'
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

let lastCode = ''
const sendCode: SendCode = async (_to, code) => {
  lastCode = code
  return 'sent'
}
const auth = signInApi({
  ...SENDING,
  db,
  secret: env.AUTH_SECRET,
  sendCode,
  providers: ['google', 'github'],
  webOrigin: WEB,
})
const app = spaceApi(db)

/** Signs somebody in the way a browser would, and returns the cookie it was handed. */
async function signedIn(email: string): Promise<string> {
  const opened = await auth.request('/auth/email-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, requestKey: `k-${email}` }),
  })
  const { codeId } = (await opened.json()) as { codeId: string }

  const verified = await auth.request(`/auth/email-codes/${codeId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: lastCode }),
  })
  return (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

async function as(cookie: string, path: string, method = 'GET', json?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  })
}

async function makeSpace(cookie: string, displayName: string, key: string): Promise<Response> {
  return as(cookie, '/spaces', 'POST', { displayName, requestKey: key })
}

describe('making a Space', () => {
  it('creates it and shows the address it got', async () => {
    const cookie = await signedIn(`mina-${RUN}@example.com`)

    const response = await makeSpace(cookie, `徐悦泰 ${RUN.slice(0, 8)}`, `${RUN}-r1`)

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ slug: `徐悦泰-${RUN.slice(0, 8)}` })
  })

  it('makes only one when the same request arrives twice', async () => {
    const cookie = await signedIn(`mina-${RUN}@example.com`)

    const first = await makeSpace(cookie, `Acme ${RUN.slice(0, 8)}`, `${RUN}-r1`)
    const second = await makeSpace(cookie, `Acme ${RUN.slice(0, 8)}`, `${RUN}-r1`)

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(await first.json()).toEqual(await second.json())
  })

  it('offers a different address when the one asked for is held', async () => {
    const mina = await signedIn(`mina-${RUN}@example.com`)
    const rui = await signedIn(`rui-${RUN}@example.com`)
    await makeSpace(mina, `Acme ${RUN.slice(0, 8)}`, `${RUN}-r1`)

    const response = await makeSpace(rui, `Acme ${RUN.slice(0, 8)}`, `${RUN}-r2`)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      reason: 'slug-taken',
      recovery: 'choose-another-name',
      suggestion: `acme-${RUN.slice(0, 8)}-2`,
    })
  })

  it('refuses a name that has no address in it', async () => {
    const cookie = await signedIn(`mina-${RUN}@example.com`)

    const response = await makeSpace(cookie, '!!!', `${RUN}-r1`)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      reason: 'unusable-name',
      recovery: 'choose-another-name',
    })
  })
})

describe('entering a Space', () => {
  it('lets a member in', async () => {
    const cookie = await signedIn(`mina-${RUN}@example.com`)
    await makeSpace(cookie, `Acme ${RUN.slice(0, 8)}`, `${RUN}-r1`)

    const response = await as(cookie, `/spaces/acme-${RUN.slice(0, 8)}`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ slug: `acme-${RUN.slice(0, 8)}` })
  })

  it('answers somebody else exactly as it answers a Space that is not there', async () => {
    const mina = await signedIn(`mina-${RUN}@example.com`)
    const rui = await signedIn(`rui-${RUN}@example.com`)
    await makeSpace(mina, `Acme ${RUN.slice(0, 8)}`, `${RUN}-r1`)

    const notMine = await as(rui, `/spaces/acme-${RUN.slice(0, 8)}`)
    const notThere = await as(rui, '/spaces/nothing-here')
    const [mineBody, thereBody] = [await notMine.json(), await notThere.json()]

    // Otherwise the address bar becomes a way to find out which names are taken.
    expect(notMine.status).toBe(notThere.status)
    expect(mineBody).toEqual(thereBody)
    expect(mineBody).toEqual({ reason: 'unavailable', recovery: 'start-over' })
  })
})
