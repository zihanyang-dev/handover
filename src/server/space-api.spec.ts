import { afterAll, describe, expect, it } from 'vitest'
import { connect, type Database } from '../db/connection.ts'
import { loadEnv } from '../env.ts'
import { authApi, type SendCode } from './auth-api.ts'
import { SESSION_COOKIE } from './session.ts'
import { spaceApi } from './space-api.ts'

const env = loadEnv()
const db: Database = connect(env)

let lastCode = ''
const sendCode: SendCode = async (_to, code) => {
  lastCode = code
  return 'sent'
}
const auth = authApi({ db, secret: env.AUTH_SECRET, sendCode, providers: ['google', 'github'] })
const app = spaceApi({ db, providers: ['google', 'github'] })

afterAll(async () => {
  await db.destroy()
})

/** Signs somebody in the way a browser would, and returns the cookie it was handed. */
async function signedIn(email: string): Promise<string> {
  const opened = await auth.request('/auth/email/challenges', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, requestKey: `k-${email}` }),
  })
  const { challengeId } = (await opened.json()) as { challengeId: string }

  const verified = await auth.request(`/auth/email/challenges/${challengeId}/verify`, {
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
  it('starts named after the address, with the emailed code as the way in', async () => {
    const cookie = await signedIn('mina@example.com')

    const me = (await (await as(cookie, '/me')).json()) as {
      displayName: string
      waysIn: { kind: string; state: string }[]
      spaces: unknown[]
    }

    expect(me.displayName).toBe('mina@example.com')
    expect(me.spaces).toEqual([])
    expect(me.waysIn).toEqual([
      { kind: 'email-code', state: 'ready' },
      { kind: 'google', state: 'connectable' },
      { kind: 'github', state: 'connectable' },
    ])
  })

  it('takes a new name', async () => {
    const cookie = await signedIn('mina@example.com')

    expect((await as(cookie, '/me', 'PATCH', { displayName: '  Mina Kim  ' })).status).toBe(204)

    const me = (await (await as(cookie, '/me')).json()) as { displayName: string }
    expect(me.displayName).toBe('Mina Kim')
  })
})

describe('making a Space', () => {
  it('creates it and shows the address it got', async () => {
    const cookie = await signedIn('mina@example.com')

    const response = await makeSpace(cookie, '徐悦泰 Studio', 'r1')

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ slug: '徐悦泰-studio' })
  })

  it('makes only one when the same request arrives twice', async () => {
    const cookie = await signedIn('mina@example.com')

    const first = await makeSpace(cookie, 'Acme', 'r1')
    const second = await makeSpace(cookie, 'Acme', 'r1')

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(await first.json()).toEqual(await second.json())
  })

  it('offers a different address when the one asked for is held', async () => {
    const mina = await signedIn('mina@example.com')
    const rui = await signedIn('rui@example.com')
    await makeSpace(mina, 'Acme', 'r1')

    const response = await makeSpace(rui, 'Acme', 'r2')

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      reason: 'slug-taken',
      recovery: 'choose-another-name',
      suggestion: 'acme-2',
    })
  })

  it('refuses a name that has no address in it', async () => {
    const cookie = await signedIn('mina@example.com')

    const response = await makeSpace(cookie, '!!!', 'r1')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      reason: 'unusable-name',
      recovery: 'choose-another-name',
    })
  })

  it('lists it afterwards, oldest first', async () => {
    const cookie = await signedIn('mina@example.com')
    await makeSpace(cookie, 'First', 'r1')
    await makeSpace(cookie, 'Second', 'r2')

    const me = (await (await as(cookie, '/me')).json()) as { spaces: { slug: string }[] }

    expect(me.spaces.map((space) => space.slug)).toEqual(['first', 'second'])
  })
})

describe('entering a Space', () => {
  it('lets a member in', async () => {
    const cookie = await signedIn('mina@example.com')
    await makeSpace(cookie, 'Acme', 'r1')

    const response = await as(cookie, '/spaces/acme')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ slug: 'acme' })
  })

  it('answers somebody else exactly as it answers a Space that is not there', async () => {
    const mina = await signedIn('mina@example.com')
    const rui = await signedIn('rui@example.com')
    await makeSpace(mina, 'Acme', 'r1')

    const notMine = await as(rui, '/spaces/acme')
    const notThere = await as(rui, '/spaces/nothing-here')
    const [mineBody, thereBody] = [await notMine.json(), await notThere.json()]

    // Otherwise the address bar becomes a way to find out which names are taken.
    expect(notMine.status).toBe(notThere.status)
    expect(mineBody).toEqual(thereBody)
    expect(mineBody).toEqual({ reason: 'unavailable', recovery: 'start-over' })
  })
})

describe('leaving', () => {
  it('makes the cookie stop working', async () => {
    const cookie = await signedIn('mina@example.com')
    expect((await as(cookie, '/me')).status).toBe(200)

    expect((await as(cookie, '/browser/sessions/current', 'DELETE')).status).toBe(204)

    expect((await as(cookie, '/me')).status).toBe(401)
  })
})
