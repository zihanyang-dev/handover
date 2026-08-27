import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import { sql } from 'kysely'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { connect, type Database } from '../db/connection.ts'
import { loadEnv } from '../env.ts'
import { MAX_ATTEMPTS, RESEND_INTERVAL_SECONDS } from '../identity/email-code.ts'
import { callerAddress, callerId, credentialApi, type SendCode } from './credential-api.ts'
import type { Recovery } from './failure.ts'
import { meApi } from './me-api.ts'
import { mounted } from './route.ts'
import { SESSION_COOKIE } from './session.ts'

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
/** A request key is unique per asker, so a fresh one per test keeps them out of each other's way. */
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

const app = mounted(
  credentialApi({
    ...SENDING,
    db,
    secret: env.AUTH_SECRET,
    sendCode,
    providers: ['google', 'github'],
    webOrigin: WEB,
  }),
)

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
    return mounted(
      credentialApi({
        ...SENDING,
        webOrigin: WEB,
        db,
        secret: env.AUTH_SECRET,
        sendCode: async () => delivery,
        providers: ['google', 'github'],
      }),
    )
  }

  async function ask(app: ReturnType<typeof mounted>, key: string): Promise<Response> {
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
    const half = mounted(
      credentialApi({
        ...SENDING,
        db,
        secret: env.AUTH_SECRET,
        sendCode,
        providers: ['google'],
        webOrigin: WEB,
      }),
    )

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
    const overTls = mounted(
      credentialApi({
        ...SENDING,
        db,
        secret: env.AUTH_SECRET,
        sendCode,
        providers: ['google', 'github'],
        webOrigin: 'https://handover.example',
      }),
    )
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

const me = mounted(meApi({ db, providers: ['google', 'github'] }))

/** The code in the letter that just went out, which is the only place it exists. */
function codeSent(): string {
  return sent.at(-1)?.code ?? ''
}

/** Signs somebody in the way a browser would, and returns the cookie it was handed. */
async function signedIn(address: string): Promise<string> {
  const opened = await app.request('/auth/email-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: address, requestKey: `in-${address}` }),
  })
  const { codeId } = (await opened.json()) as { codeId: string }

  const answered = await app.request('/browser/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codeId, code: codeSent() }),
  })
  const cookie = answered.headers.getSetCookie().join(';')
  return `${SESSION_COOKIE}=${cookie.split(`${SESSION_COOKIE}=`)[1]?.split(';')[0] ?? ''}`
}

async function ask(address: string, cookie?: string): Promise<Response> {
  return app.request('/me/credentials/email-codes', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ email: address, requestKey: `add-${address}` }),
  })
}

async function answer(id: string, code: string, cookie?: string): Promise<Response> {
  return app.request('/me/credentials', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ codeId: id, code }),
  })
}

/** Everything that opens this account, read back the way the account screen reads it. */
async function opensWith(cookie: string): Promise<readonly string[]> {
  const seen = (await (await me.request('/me', { headers: { cookie } })).json()) as {
    credentials: { kind: string; address?: string }[]
  }
  return seen.credentials
    .filter((one) => one.kind === 'email')
    .map((one) => one.address ?? '<none>')
}

describe('without a live session', () => {
  it('will not send a code, because there is no account to add it to', async () => {
    const refused = await ask(`nobody-${RUN}@example.com`)

    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ recovery: 'sign-in' })
  })

  it('will not take one back either', async () => {
    const refused = await answer(randomUUID(), '493018')

    expect(refused.status).toBe(401)
  })
})

describe('adding an address', () => {
  it('makes it another way into the same account', async () => {
    const first = `mina-${RUN}@example.com`
    const second = `zane-${RUN}@example.com`
    const cookie = await signedIn(first)

    const { codeId } = (await (await ask(second, cookie)).json()) as { codeId: string }
    const added = await answer(codeId, codeSent(), cookie)

    expect(added.status).toBe(204)
    expect(await opensWith(cookie)).toEqual([first, second])
  })

  it('refuses an address that already opens somebody else, and moves nothing', async () => {
    const mina = await signedIn(`mina-${RUN}@example.com`)
    const ruiAddress = `rui-${RUN}@example.com`
    const rui = await signedIn(ruiAddress)

    const { codeId } = (await (await ask(ruiAddress, mina)).json()) as { codeId: string }
    const taken = await answer(codeId, codeSent(), mina)

    expect(taken.status).toBe(409)
    expect(await taken.json()).toEqual({ reason: 'address-elsewhere', recovery: 'retype' })
    expect(await opensWith(rui)).toEqual([ruiAddress])
    expect(await opensWith(mina)).toEqual([`mina-${RUN}@example.com`])
  })

  it('refuses the wrong digits without adding anything', async () => {
    const first = `mina-${RUN}@example.com`
    const cookie = await signedIn(first)

    const { codeId } = (await (await ask(`zane-${RUN}@example.com`, cookie)).json()) as {
      codeId: string
    }
    const wrong = await answer(codeId, '000000', cookie)

    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({ reason: 'code-mismatch' })
    expect(await opensWith(cookie)).toEqual([first])
  })

  it('answers an id that is not an id the way it answers one that is gone', async () => {
    const cookie = await signedIn(`mina-${RUN}@example.com`)

    const nonsense = await answer('not-an-id', '493018', cookie)

    expect(nonsense.status).toBe(404)
    expect(await nonsense.json()).toMatchObject({ reason: 'no-code' })
  })

  it('will not spend a code that was sent to sign in', async () => {
    // Two purposes, two letters. A code somebody was talked into forwarding cannot be turned into
    // a way into the forwarder's account.
    const cookie = await signedIn(`mina-${RUN}@example.com`)
    const elsewhere = `zane-${RUN}@example.com`

    const opened = await app.request('/auth/email-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: elsewhere, requestKey: `crossed-${RUN}` }),
    })
    const { codeId } = (await opened.json()) as { codeId: string }
    const crossed = await answer(codeId, codeSent(), cookie)

    expect(crossed.status).toBe(404)
    expect(await crossed.json()).toMatchObject({ reason: 'no-code' })
  })
})

/** A request as it arrives, with whatever headers somebody put on it. */
function arriving(headers: Record<string, string> = {}): Context {
  return { req: { header: (name: string) => headers[name.toLowerCase()] } } as unknown as Context
}

describe('who is calling', () => {
  it('ignores a forwarding header when no proxy was configured', () => {
    // Unset, that header is written by whoever is calling. Trusting it turns a limit into a
    // counter anybody can reset by making one up.
    const said = arriving({ 'x-forwarded-for': '198.51.100.7' })

    expect(callerAddress(said, 0)).toBeNull()
  })

  it('reads the entry our own proxy wrote, not the ones before it', () => {
    // The header is a list each proxy appends to. Everything left of ours was written by whoever
    // was calling and can say anything at all.
    const said = arriving({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' })

    expect(callerAddress(said, 1)).toBe('203.0.113.9')
    expect(callerAddress(said, 2)).toBe('1.1.1.1')
  })

  it('is nobody when the header a proxy should have written is not there', () => {
    expect(callerAddress(arriving(), 1)).toBeNull()
  })

  it('keeps the address out of whatever is stored', () => {
    // What is wanted is "the same caller as before". An address is somebody's location, and a
    // column of them is a log of where people sign in from.
    const kept = callerId('203.0.113.9')

    expect(kept).not.toContain('203.0.113')
    expect(kept).toBe(callerId('203.0.113.9'))
    expect(kept).not.toBe(callerId('203.0.113.8'))
  })

  it('is nobody when there was nobody to identify', () => {
    expect(callerId(null)).toBeNull()
  })
})
