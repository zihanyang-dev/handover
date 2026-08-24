import { randomUUID } from 'node:crypto'
import { beforeEach, afterAll, describe, expect, it } from 'vitest'
import { openSession } from '../db/browser-session.ts'
import { personFor } from '../db/user.ts'
import { newSessionToken } from '../identity/browser-session.ts'
import type { ProviderIdentity } from '../identity/provider.ts'
import { oauthApi } from './oauth-api.ts'
import type { Identified, ProviderClient } from './oauth/provider-client.ts'
import { SESSION_COOKIE } from './session.ts'
import { connect, type Database } from '../db/connection.ts'
import { loadEnv } from '../env.ts'

const env = loadEnv()
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

/** A fresh address per test, so no test depends on the database being empty when it starts. */
/** Request keys are unique across the whole table, so they have to be fresh per test too. */
let RUN = ''
let EMAIL = ''

beforeEach(() => {
  RUN = randomUUID()
  EMAIL = `mina-${randomUUID()}@example.com`
})
const ORIGIN = 'http://localhost:3000'
const WEB = 'http://localhost:5173'

let MINA: ProviderIdentity = {
  provider: 'google',
  subject: '',
  verifiedEmail: '',
  name: 'Mina Kim',
  username: null,
}

beforeEach(() => {
  // The provider's id has to be fresh too: two tests sharing one would be sharing an account.
  MINA = { ...MINA, subject: `google-${randomUUID()}`, verifiedEmail: EMAIL }
})

/** A provider that hands back whatever a test told it to, without ever leaving the process. */
function stub(answer: Identified | Error): ProviderClient {
  return {
    begin: async () => ({
      url: new URL('https://provider.example/authorize?client_id=x'),
      state: 'state-value',
      pkceVerifier: 'verifier-value',
    }),
    identify: async () => {
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

function appWith(answer: Identified): ReturnType<typeof oauthApi> {
  const client = stub(answer)
  return oauthApi({
    db,
    secret: env.AUTH_SECRET,
    origin: ORIGIN,
    webOrigin: WEB,
    clients: { google: client, github: client },
  })
}

const identified = (identity: ProviderIdentity): Identified => ({ kind: 'identified', identity })

function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ')
}

async function start(
  app: ReturnType<typeof oauthApi>,
  next?: string,
  cookie = '',
): Promise<Response> {
  return app.request('/auth/google/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(next === undefined ? {} : { next }),
  })
}

async function comeBack(
  app: ReturnType<typeof oauthApi>,
  cookie: string,
  query = '?code=abc&state=state-value',
  path = '/auth/google/callback',
): Promise<Response> {
  return app.request(`${path}${query}`, { headers: { cookie } })
}

async function signedInCookie(email: string): Promise<{ cookie: string; userId: string }> {
  const userId = await personFor(db, { name: null, username: null, verifiedEmail: email })
  const token = newSessionToken()
  await openSession(db, userId, token.hash)
  return { cookie: `${SESSION_COOKIE}=${token.token}`, userId }
}

describe('leaving for a provider', () => {
  it('sends the browser there and remembers the trip', async () => {
    const response = await start(appWith(identified(MINA)))
    const sent = (await response.json()) as { url: string }
    const remembered = response.headers.getSetCookie().join(';')

    expect(response.status).toBe(200)
    expect(sent.url).toContain('provider.example/authorize')
    expect(remembered).toContain('handover_oauth=')
    expect(remembered).toContain('HttpOnly')
  })

  it('never remembers a destination on somebody else’s site', async () => {
    const app = appWith(identified(MINA))
    const left = await start(app, 'https://evil.example.com/phish')

    const back = await comeBack(app, cookiesOf(left))

    expect(back.headers.get('location')).toBe(`${WEB}/`)
  })

  it('refuses a name that is not a provider, without describing the route', async () => {
    const response = await appWith(identified(MINA)).request('/auth/facebook/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      reason: 'provider-unavailable',
      recovery: 'start-over',
    })
  })

  it('answers a provider without keys exactly as it answers one that does not exist', async () => {
    const client = stub(identified(MINA))
    const onlyGoogle = oauthApi({
      db,
      secret: env.AUTH_SECRET,
      origin: ORIGIN,
      webOrigin: WEB,
      clients: { google: client },
    })

    const withoutKeys = await onlyGoogle.request('/auth/github/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const madeUp = await onlyGoogle.request('/auth/facebook/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(withoutKeys.status).toBe(madeUp.status)
    expect(await withoutKeys.json()).toEqual(await madeUp.json())
  })
})

describe('coming back', () => {
  it('signs the person in and returns them to where they were going', async () => {
    const app = appWith(identified(MINA))
    const left = await start(app, '/s/acme')

    const back = await comeBack(app, cookiesOf(left))

    expect(back.status).toBe(303)
    expect(back.headers.get('location')).toBe(`${WEB}/s/acme`)
    expect(back.headers.getSetCookie().join(';')).toContain(`${SESSION_COOKIE}=`)
  })

  it('says so, once, when it joined an account the address already had', async () => {
    await signedInCookie(EMAIL)
    const app = appWith(identified(MINA))
    const left = await start(app, '/')

    const back = await comeBack(app, cookiesOf(left))

    expect(back.headers.get('location')).toBe(`${WEB}/?handover_result=merged`)
  })

  it('turns away an arrival that did not start here', async () => {
    const back = await comeBack(appWith(identified(MINA)), '')

    expect(back.headers.get('location')).toBe(`${WEB}/?handover_result=expired`)
    expect(back.headers.getSetCookie().join(';')).not.toContain(SESSION_COOKIE)
  })

  it('turns away a handoff belonging to a different provider', async () => {
    const app = appWith(identified(MINA))
    const left = await start(app)

    const back = await comeBack(
      app,
      cookiesOf(left),
      '?code=abc&state=state-value',
      '/auth/github/callback',
    )

    expect(back.headers.get('location')).toBe(`${WEB}/?handover_result=expired`)
  })

  it('turns away a handoff whose signature does not hold', async () => {
    const app = appWith(identified(MINA))
    const left = await start(app)
    const tampered = cookiesOf(left).replace('handover_oauth=', 'handover_oauth=x')

    const back = await comeBack(app, tampered)

    expect(back.headers.get('location')).toBe(`${WEB}/?handover_result=expired`)
  })

  it('says nothing happened when the person said no over there', async () => {
    const app = appWith(identified(MINA))
    const left = await start(app, '/s/acme')

    const back = await comeBack(app, cookiesOf(left), '?error=access_denied')

    expect(back.headers.get('location')).toBe(`${WEB}/s/acme?handover_result=cancelled`)
    expect(back.headers.getSetCookie().join(';')).not.toContain(SESSION_COOKIE)
  })

  it('refuses to take an address nobody proved', async () => {
    const app = appWith({ kind: 'no-verified-email' })
    const left = await start(app, '/')

    const back = await comeBack(app, cookiesOf(left))

    expect(back.headers.get('location')).toBe(`${WEB}/?handover_result=no-verified-email`)
    const made = await db
      .selectFrom('users')
      .select('id')
      .where('verified_email', 'like', `%${RUN}%`)
      .execute()
    expect(made).toEqual([])
  })

  it('spends the handoff, whatever it ended in', async () => {
    const app = appWith(identified(MINA))
    const left = await start(app)

    const back = await comeBack(app, cookiesOf(left))

    expect(back.headers.getSetCookie().join(';')).toContain('handover_oauth=;')
  })
})

describe('connecting one to an account already signed in', () => {
  it('connects it and comes back with nothing to report', async () => {
    const { cookie } = await signedInCookie(EMAIL)
    const app = appWith(identified(MINA))
    const left = await app.request('/me/sign-in-methods/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ next: '/s/acme' }),
    })

    const back = await comeBack(app, `${cookie}; ${cookiesOf(left)}`)

    expect(back.headers.get('location')).toBe(`${WEB}/s/acme`)
  })

  it('says which way it failed when the provider proves another address', async () => {
    const { cookie } = await signedInCookie(EMAIL)
    const app = appWith(identified({ ...MINA, verifiedEmail: `else-${randomUUID()}@example.com` }))
    const left = await app.request('/me/sign-in-methods/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    })

    const back = await comeBack(app, `${cookie}; ${cookiesOf(left)}`)

    expect(back.headers.get('location')).toBe(`${WEB}/?handover_result=email-mismatch`)
  })

  it('refuses to connect anything once the session that asked is gone', async () => {
    const { cookie } = await signedInCookie(EMAIL)
    const app = appWith(identified(MINA))
    const left = await app.request('/me/sign-in-methods/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    })

    // The handoff comes back without the session it was started under.
    const back = await comeBack(app, cookiesOf(left))

    expect(back.headers.get('location')).toBe(`${WEB}/?handover_result=expired`)
  })

  it('will not start one at all without a session', async () => {
    const response = await appWith(identified(MINA)).request('/me/sign-in-methods/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(401)
  })
})
