import { sql } from 'kysely'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_ATTEMPTS, RESEND_INTERVAL_SECONDS } from '../identity/email-code.ts'
import { signInApi, type SendCode } from './sign-in-api.ts'
import type { Recovery } from './failure.ts'
import { SESSION_COOKIE } from './session.ts'
import { connect, type Database } from '../db/connection.ts'
import { loadEnv } from '../env.ts'

const env = loadEnv()

/** Room enough that no test trips the per-caller limit, and no proxy to believe. */
const SENDING = { lettersPerCallerPerHour: 500, trustedProxyHops: 0 }

/** Where a browser reaches this app, which is what decides whether a cookie is `Secure`. */
const WEB = 'http://localhost:5173'
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

let sent: { to: string; code: string }[] = []
const sendCode: SendCode = async (to, code) => {
  sent.push({ to, code })
  return 'sent'
}
const app = signInApi({
  ...SENDING,
  db,
  secret: env.AUTH_SECRET,
  sendCode,
  providers: ['google', 'github'],
  webOrigin: WEB,
})

beforeEach(() => {
  sent = []
})

async function askForCode(requestKey = `${RUN}-k1`, email = EMAIL): Promise<Response> {
  return app.request('/auth/email-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, requestKey }),
  })
}

async function codeId(requestKey = `${RUN}-k1`): Promise<string> {
  const body = (await (await askForCode(requestKey)).json()) as { codeId: string }
  return body.codeId
}

/** Moves a code back in time, so a test can reach past the resend interval without waiting. */
async function age(email: string): Promise<void> {
  await db
    .updateTable('email_codes')
    .set({ created_at: sql`created_at - make_interval(secs => ${RESEND_INTERVAL_SECONDS})` })
    .where('email', '=', email)
    .execute()
}

async function submit(id: string, code: string): Promise<Response> {
  return app.request('/browser/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codeId: id, code }),
  })
}

async function failureOf(
  id: string,
  code: string,
): Promise<{ status: number; reason: string; recovery: Recovery }> {
  const response = await submit(id, code)
  const body = (await response.json()) as { reason: string; recovery: Recovery }
  return { status: response.status, ...body }
}

describe('asking for a code', () => {
  it('sends one and names the code', async () => {
    const response = await askForCode()

    expect(response.status).toBe(201)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(EMAIL)
  })

  it('sends nothing extra when the same request arrives again', async () => {
    await askForCode(`${RUN}-k1`)
    await askForCode(`${RUN}-k1`)

    expect(sent).toHaveLength(1)
  })

  it('tells a second ask to wait, and how long', async () => {
    await askForCode(`${RUN}-k1`)

    const response = await askForCode(`${RUN}-k2`)

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/u)
    expect(await response.json()).toMatchObject({ reason: 'too-soon', recovery: 'wait' })
    expect(sent).toHaveLength(1)
  })

  it('sends again once the wait is over', async () => {
    await askForCode(`${RUN}-k1`)
    await age(EMAIL)

    expect((await askForCode(`${RUN}-k2`)).status).toBe(201)
    expect(sent).toHaveLength(2)
  })

  it('refuses an address that is not one', async () => {
    const response = await app.request('/auth/email-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-address', requestKey: `${RUN}-k1` }),
    })

    expect(response.status).toBe(400)
    expect(sent).toEqual([])
  })
})

describe('when the letter did not go', () => {
  function whenDeliveryIs(delivery: Awaited<ReturnType<SendCode>>) {
    return signInApi({
      ...SENDING,
      webOrigin: WEB,
      db,
      secret: env.AUTH_SECRET,
      sendCode: async () => delivery,
      providers: ['google', 'github'],
    })
  }

  async function ask(app: ReturnType<typeof signInApi>, key: string): Promise<Response> {
    return app.request('/auth/email-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, requestKey: key }),
    })
  }

  it('refuses when the provider refused, instead of sending somebody to an empty inbox', async () => {
    const answered = await ask(whenDeliveryIs('refused'), `${RUN}-refused`)

    expect(answered.status).toBe(400)
    expect(await answered.json()).toEqual({
      reason: 'address-refused',
      recovery: 'retype' satisfies Recovery,
    })
  })

  it('still says a code is on its way when nobody knows, because it may already be', async () => {
    // The letter may be in flight. Refusing here would tell somebody to retype an address that
    // is about to receive a code, and the retry would then be the second one in their inbox.
    const answered = await ask(whenDeliveryIs('unknown'), `${RUN}-unknown`)

    expect(answered.status).toBe(201)
  })
})

describe('what a stranger is offered', () => {
  it('names the ways in, so a sign-in page cannot show a door that opens onto an error', async () => {
    const response = await app.request('/auth/credentials')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ offered: ['email', 'google', 'github'] })
  })

  it('leaves out a provider this deployment has no keys for', async () => {
    const half = signInApi({
      ...SENDING,
      db,
      secret: env.AUTH_SECRET,
      sendCode,
      providers: ['google'],
      webOrigin: WEB,
    })

    const offered = (await (await half.request('/auth/credentials')).json()) as {
      offered: string[]
    }

    expect(offered.offered).toEqual(['email', 'google'])
  })
})

describe('handing the code back', () => {
  it('signs the person in and sets a cookie the page cannot read', async () => {
    const id = await codeId()

    const response = await submit(id, sent[0]?.code ?? '')

    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${SESSION_COOKIE}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('marks the cookie Secure from the configured origin, not from the request', async () => {
    // The ordinary production arrangement: TLS ends at a proxy and plain HTTP reaches this
    // process, so `c.req.url` says `http:` on every real request. Read from there, every session
    // cookie in production would go out without `Secure` and nothing would say so — the tests
    // would still be green, because they all speak HTTP.
    const overTls = signInApi({
      ...SENDING,
      db,
      secret: env.AUTH_SECRET,
      sendCode,
      providers: ['google', 'github'],
      webOrigin: 'https://handover.example',
    })
    const asked = await overTls.request('/auth/email-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, requestKey: `${RUN}-tls` }),
    })
    const { codeId: id } = (await asked.json()) as { codeId: string }

    const response = await overTls.request('/browser/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codeId: id, code: sent.at(-1)?.code ?? '' }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie') ?? '').toContain('Secure')
  })

  it('leaves Secure off when a browser really does reach it over plain HTTP', async () => {
    // The other half, so the rule cannot be satisfied by always saying Secure — a cookie a local
    // browser is told to send only over HTTPS is a cookie it never sends.
    const id = await codeId()

    const response = await submit(id, sent[0]?.code ?? '')

    expect(response.headers.get('set-cookie') ?? '').not.toContain('Secure')
  })

  it('never puts the stored hash in the cookie', async () => {
    const id = await codeId()

    const response = await submit(id, sent[0]?.code ?? '')

    const stored = await db
      .selectFrom('browser_sessions')
      .select('token_hash')
      .executeTakeFirstOrThrow()
    expect(response.headers.get('set-cookie') ?? '').not.toContain(stored.token_hash)
  })
})

describe('each way it can fail', () => {
  it('wrong digits: retype, and the code stays open', async () => {
    const id = await codeId()

    expect(await failureOf(id, '000000')).toEqual({
      status: 400,
      reason: 'code-mismatch',
      recovery: 'retype',
    })
  })

  it('already used: say so, and ask for another', async () => {
    const id = await codeId()
    await submit(id, sent[0]?.code ?? '')

    expect(await failureOf(id, sent[0]?.code ?? '')).toEqual({
      status: 409,
      reason: 'consumed',
      recovery: 'request-new-code',
    })
  })

  it('replaced by a newer code: expired, and ask for another', async () => {
    const stale = await codeId(`${RUN}-k1`)
    await age(EMAIL)
    await askForCode(`${RUN}-k2`)

    expect(await failureOf(stale, sent[0]?.code ?? '')).toEqual({
      status: 409,
      reason: 'expired',
      recovery: 'request-new-code',
    })
  })

  it('out of tries: start over', async () => {
    const id = await codeId()
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await submit(id, '000000')

    expect(await failureOf(id, sent[0]?.code ?? '')).toEqual({
      status: 429,
      reason: 'attempts-exhausted',
      recovery: 'start-over',
    })
  })

  it('no such code: start over', async () => {
    const gone = '00000000-0000-0000-0000-000000000000'

    expect(await failureOf(gone, '000000')).toEqual({
      status: 404,
      reason: 'no-code',
      recovery: 'start-over',
    })
  })

  it('an id that is not an id gets the same answer as one that is gone', async () => {
    expect(await failureOf('not-a-uuid', '000000')).toEqual({
      status: 404,
      reason: 'no-code',
      recovery: 'start-over',
    })
  })

  it('keeps used and wrong apart, because only one of them means somebody else got in', async () => {
    const used = await codeId(`${RUN}-k1`)
    await submit(used, sent[0]?.code ?? '')
    const open = await codeId(`${RUN}-k2`)

    const a = await failureOf(used, '000000')
    const b = await failureOf(open, '000000')

    expect(a.reason).not.toBe(b.reason)
  })

  it('never says which part of the code was right', async () => {
    const id = await codeId()
    const right = sent[0]?.code ?? ''
    const nearMiss = `${right.slice(0, 5)}${right[5] === '0' ? '1' : '0'}`

    expect(await failureOf(id, nearMiss)).toEqual(await failureOf(id, '999999'))
  })
})
