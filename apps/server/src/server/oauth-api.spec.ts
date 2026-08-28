import { randomUUID } from 'node:crypto'
import { beforeEach, afterAll, describe, expect, it } from 'vitest'
import { connect, type Database } from '../db/connection.ts'
import { credentialsOf } from '../db/credential.ts'
import { openSession } from '../db/session.ts'
import { arrive } from '../db/user.ts'
import { loadEnv } from '../env.ts'
import type { Identified, ProviderClient } from '../identity/provider-client.ts'
import type { ProviderIdentity } from '../identity/provider.ts'
import { newSessionToken } from '../identity/session.ts'
import { oauthApi } from './oauth-api.ts'
import { mounted } from './route.ts'
import { SESSION_COOKIE } from './session.ts'

const env = loadEnv()
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

/** A fresh address per test, so no test depends on the database being empty when it starts. */
/** A request key is unique per asker, so a fresh one per test keeps them out of each other's way. */
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

function appWith(answer: Identified): ReturnType<typeof mounted> {
  const client = stub(answer)
  return mounted(
    oauthApi({
      db,
      secret: env.AUTH_SECRET,
      origin: ORIGIN,
      webOrigin: WEB,
      clients: { google: client, github: client },
    }),
  )
}

const identified = (identity: ProviderIdentity): Identified => ({ kind: 'identified', identity })

function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ')
}

async function start(
  app: ReturnType<typeof mounted>,
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
  app: ReturnType<typeof mounted>,
  cookie: string,
  query = '?code=abc&state=state-value',
  path = '/auth/google/callback',
): Promise<Response> {
  return app.request(`${path}${query}`, { headers: { cookie } })
}

async function signedInCookie(address: string): Promise<{ cookie: string; userId: string }> {
  const arrived = await db
    .transaction()
    .execute(async (tx) =>
      arrive(tx, { kind: 'email', subject: address }, { name: null, username: null, address }),
    )
  const token = newSessionToken()
  await openSession(db, { user: arrived.userId, tokenHash: token.hash })
  return { cookie: `${SESSION_COOKIE}=${token.token}`, userId: arrived.userId }
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
    const onlyGoogle = mounted(
      oauthApi({
        db,
        secret: env.AUTH_SECRET,
        origin: ORIGIN,
        webOrigin: WEB,
        clients: { google: client },
      }),
    )

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

  it('lands on a page when the provider does something nobody planned for', async () => {
    // The browser got here by being redirected. It needs the same retry as an expired trip, not
    // the false claim that its provider account lacks a verified address.
    const breaking = {
      begin: async () => ({
        url: new URL('https://accounts.google.com/o'),
        state: 'state-value',
        pkceVerifier: 'v',
      }),
      identify: async (): Promise<Identified> => {
        throw new Error('the token endpoint broke')
      },
    }
    const app = mounted(
      oauthApi({
        db,
        secret: env.AUTH_SECRET,
        origin: ORIGIN,
        webOrigin: WEB,
        clients: { google: breaking, github: breaking },
      }),
    )
    const left = await app.request('/auth/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    const back = await comeBack(app, cookiesOf(left))

    expect(back.status).toBe(303)
    expect(back.headers.get('location')).toBe(`${WEB}/?handover_result=expired`)
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
      .selectFrom('credentials')
      .select('user_id')
      .where('subject', 'like', `%${RUN}%`)
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
    const left = await app.request('/me/credentials/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ next: '/s/acme' }),
    })

    const back = await comeBack(app, `${cookie}; ${cookiesOf(left)}`)

    expect(back.headers.get('location')).toBe(`${WEB}/s/acme`)
  })

  it('takes one that proves a different address, because the session already proved the account', async () => {
    // The session is the proof of whose account this is. Demanding the addresses match protected
    // nothing once the account stopped being an address.
    const { cookie } = await signedInCookie(EMAIL)
    const app = appWith(identified({ ...MINA, verifiedEmail: `else-${randomUUID()}@example.com` }))
    const left = await app.request('/me/credentials/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    })

    const back = await comeBack(app, `${cookie}; ${cookiesOf(left)}`)

    expect(back.headers.get('location')).toBe(`${WEB}/`)
  })

  it("says which way it failed when that provider account is somebody else's", async () => {
    // The rejection has to reach the page. It was silent once, and a connection that failed
    // silently is indistinguishable from a button that does nothing.
    const rui = await signedInCookie(`rui-${randomUUID()}@example.com`)
    const taken = appWith(identified(MINA))
    const first = await taken.request('/me/credentials/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: rui.cookie },
      body: '{}',
    })
    await comeBack(taken, `${rui.cookie}; ${cookiesOf(first)}`)

    const mina = await signedInCookie(EMAIL)
    const app = appWith(identified(MINA))
    const left = await app.request('/me/credentials/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: mina.cookie },
      body: '{}',
    })

    const back = await comeBack(app, `${mina.cookie}; ${cookiesOf(left)}`)

    expect(back.headers.get('location')).toBe(`${WEB}/?handover_result=linked-elsewhere`)
  })

  it('answers a provider it has no keys for the same way it answers a made-up name', async () => {
    const { cookie } = await signedInCookie(EMAIL)

    const asked = await appWith(identified(MINA)).request('/me/credentials/myspace/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    })

    expect(asked.status).toBe(404)
    expect(await asked.json()).toMatchObject({ reason: 'provider-unavailable' })
  })

  it('refuses to connect anything once the session that asked is gone', async () => {
    const { cookie } = await signedInCookie(EMAIL)
    const app = appWith(identified(MINA))
    const left = await app.request('/me/credentials/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    })

    // The handoff comes back without the session it was started under.
    const back = await comeBack(app, cookiesOf(left))

    expect(back.headers.get('location')).toBe(`${WEB}/?handover_result=expired`)
  })

  it('will not hand the credential to whoever is signed in when it comes back', async () => {
    // Alice starts a connection, signs out, and Bob signs in on the same browser before the trip
    // finishes. "Whoever is signed in now" is not the person who asked, and the way in would land
    // on Bob's account.
    const alice = await signedInCookie(`alice-${randomUUID()}@example.com`)
    const bob = await signedInCookie(`bob-${randomUUID()}@example.com`)
    const app = appWith(identified(MINA))
    const left = await app.request('/me/credentials/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: alice.cookie },
      body: '{}',
    })

    const back = await comeBack(app, `${cookiesOf(left)}; ${bob.cookie}`)

    expect(back.headers.get('location')).toBe(`${WEB}/?handover_result=expired`)
    expect(await credentialsOf(db, bob.userId)).not.toContainEqual({
      kind: 'google',
      subject: MINA.subject,
    })
  })

  it('will not start one at all without a session', async () => {
    const response = await appWith(identified(MINA)).request('/me/credentials/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(401)
  })
})
