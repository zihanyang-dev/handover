import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { signInApi, type SendCode } from './sign-in-api.ts'
import { SESSION_COOKIE } from './session.ts'
import { meApi } from './me-api.ts'
import { createSpace } from '../db/space.ts'
import { userHolding } from '../db/session.ts'
import { hashSessionToken } from '../identity/session.ts'
import { normalizeSlug } from '@handover/universal'
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
const app = meApi({ db, providers: ['google', 'github'] })

/** Signs somebody in the way a browser would, and returns the cookie it was handed. */
async function signedIn(email: string): Promise<string> {
  const opened = await auth.request('/auth/email-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, requestKey: `k-${email}` }),
  })
  const { codeId } = (await opened.json()) as { codeId: string }

  const verified = await auth.request('/browser/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codeId, code: lastCode }),
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

describe('without a live session', () => {
  it('refuses, and says to sign in', async () => {
    const response = await app.request('/me')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ reason: 'no-session', recovery: 'sign-in' })
  })

  it('answers a made-up cookie exactly as it answers no cookie', async () => {
    const invented = await as(`${SESSION_COOKIE}=not-a-real-token`, '/me')
    const absent = await app.request('/me')

    expect(invented.status).toBe(absent.status)
    expect(await invented.json()).toEqual(await absent.json())
  })
})

describe('me', () => {
  it('starts named after the address, and lists it as a way in', async () => {
    const cookie = await signedIn(`mina-${RUN}@example.com`)

    const me = (await (await as(cookie, '/me')).json()) as {
      displayName: string
      credentials: { kind: string; address?: string; state: string }[]
      spaces: unknown[]
    }

    expect(me.displayName).toBe(`mina-${RUN}@example.com`)
    expect(me.spaces).toEqual([])
    // The address is named, not folded into an "emailed code" line. Folded, nobody could see how
    // many inboxes open this account.
    expect(me.credentials).toEqual([
      { kind: 'email', address: `mina-${RUN}@example.com`, state: 'ready' },
      { kind: 'google', state: 'connectable' },
      { kind: 'github', state: 'connectable' },
    ])
  })

  it('takes a new name', async () => {
    const cookie = await signedIn(`mina-${RUN}@example.com`)

    expect((await as(cookie, '/me', 'PATCH', { displayName: '  Mina Kim  ' })).status).toBe(204)

    const me = (await (await as(cookie, '/me')).json()) as { displayName: string }
    expect(me.displayName).toBe('Mina Kim')
  })
})

describe('leaving', () => {
  it('makes the cookie stop working', async () => {
    const cookie = await signedIn(`mina-${RUN}@example.com`)
    expect((await as(cookie, '/me')).status).toBe(200)

    expect((await as(cookie, '/browser/sessions/current', 'DELETE')).status).toBe(204)

    expect((await as(cookie, '/me')).status).toBe(401)
  })
})

/** A Space that somebody is in, without going through the route that makes one. */
async function made(cookie: string, displayName: string, requestKey: string): Promise<void> {
  const token = cookie.slice(cookie.indexOf('=') + 1)
  const userId = await userHolding(db, hashSessionToken(token))
  if (userId === undefined) throw new Error('the fixture is not signed in')
  const slug = normalizeSlug(displayName)
  if (slug === null) throw new Error('the fixture picked a name with no address')
  await createSpace(db, { requestKey, userId, displayName, slug })
}

describe('the Spaces on it', () => {
  it('lists the Spaces somebody is in, oldest first', async () => {
    const cookie = await signedIn(`mina-${RUN}@example.com`)
    // Made through the transaction rather than the route: what is under test is what `/me`
    // reports, and going through POST /spaces would test that route a second time.
    await made(cookie, `First ${RUN.slice(0, 8)}`, `${RUN}-r1`)
    await made(cookie, `Second ${RUN.slice(0, 8)}`, `${RUN}-r2`)

    const me = (await (await as(cookie, '/me')).json()) as { spaces: { slug: string }[] }

    expect(me.spaces.map((space) => space.slug)).toEqual([
      `first-${RUN.slice(0, 8)}`,
      `second-${RUN.slice(0, 8)}`,
    ])
  })
})
