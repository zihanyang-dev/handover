import { sql } from 'kysely'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { connect, type Database } from '../db/connection.ts'
import { loadEnv } from '../env.ts'
import { MAX_ATTEMPTS, RESEND_INTERVAL_SECONDS } from '../identity/emailed-code.ts'
import { authApi, type SendCode } from './auth-api.ts'
import type { Recovery } from './failure.ts'
import { SESSION_COOKIE } from './session.ts'

const env = loadEnv()
const db: Database = connect(env)
const EMAIL = 'mina@example.com'

let sent: { to: string; code: string }[] = []
const sendCode: SendCode = async (to, code) => {
  sent.push({ to, code })
  return 'sent'
}
const app = authApi({ db, secret: env.AUTH_SECRET, sendCode, providers: ['google', 'github'] })

beforeEach(() => {
  sent = []
})

afterAll(async () => {
  await db.destroy()
})

async function askForCode(requestKey = 'k1', email = EMAIL): Promise<Response> {
  return app.request('/auth/email/challenges', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, requestKey }),
  })
}

async function challengeId(requestKey = 'k1'): Promise<string> {
  const body = (await (await askForCode(requestKey)).json()) as { challengeId: string }
  return body.challengeId
}

/** Moves a challenge back in time, so a test can reach past the resend interval without waiting. */
async function age(email: string): Promise<void> {
  await db
    .updateTable('email_challenges')
    .set({ created_at: sql`created_at - make_interval(secs => ${RESEND_INTERVAL_SECONDS})` })
    .where('email', '=', email)
    .execute()
}

async function submit(id: string, code: string): Promise<Response> {
  return app.request(`/auth/email/challenges/${id}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
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
  it('sends one and names the challenge', async () => {
    const response = await askForCode()

    expect(response.status).toBe(201)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(EMAIL)
  })

  it('sends nothing extra when the same request arrives again', async () => {
    await askForCode('k1')
    await askForCode('k1')

    expect(sent).toHaveLength(1)
  })

  it('tells a second ask to wait, and how long', async () => {
    await askForCode('k1')

    const response = await askForCode('k2')

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/u)
    expect(await response.json()).toMatchObject({ reason: 'too-soon', recovery: 'wait' })
    expect(sent).toHaveLength(1)
  })

  it('sends again once the wait is over', async () => {
    await askForCode('k1')
    await age(EMAIL)

    expect((await askForCode('k2')).status).toBe(201)
    expect(sent).toHaveLength(2)
  })

  it('refuses an address that is not one', async () => {
    const response = await app.request('/auth/email/challenges', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-address', requestKey: 'k1' }),
    })

    expect(response.status).toBe(400)
    expect(sent).toEqual([])
  })
})

describe('what a stranger is offered', () => {
  it('names the ways in, so a sign-in page cannot show a door that opens onto an error', async () => {
    const response = await app.request('/auth/ways-in')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ offered: ['email-code', 'google', 'github'] })
  })

  it('leaves out a provider this deployment has no keys for', async () => {
    const half = authApi({ db, secret: env.AUTH_SECRET, sendCode, providers: ['google'] })

    const offered = (await (await half.request('/auth/ways-in')).json()) as { offered: string[] }

    expect(offered.offered).toEqual(['email-code', 'google'])
  })
})

describe('handing the code back', () => {
  it('signs the person in and sets a cookie the page cannot read', async () => {
    const id = await challengeId()

    const response = await submit(id, sent[0]?.code ?? '')

    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${SESSION_COOKIE}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('never puts the stored hash in the cookie', async () => {
    const id = await challengeId()

    const response = await submit(id, sent[0]?.code ?? '')

    const stored = await db
      .selectFrom('browser_sessions')
      .select('token_hash')
      .executeTakeFirstOrThrow()
    expect(response.headers.get('set-cookie') ?? '').not.toContain(stored.token_hash)
  })
})

describe('each way it can fail', () => {
  it('wrong digits: retype, and the challenge stays open', async () => {
    const id = await challengeId()

    expect(await failureOf(id, '000000')).toEqual({
      status: 400,
      reason: 'code-mismatch',
      recovery: 'retype',
    })
  })

  it('already used: say so, and ask for another', async () => {
    const id = await challengeId()
    await submit(id, sent[0]?.code ?? '')

    expect(await failureOf(id, sent[0]?.code ?? '')).toEqual({
      status: 409,
      reason: 'consumed',
      recovery: 'request-new-code',
    })
  })

  it('replaced by a newer code: expired, and ask for another', async () => {
    const stale = await challengeId('k1')
    await age(EMAIL)
    await askForCode('k2')

    expect(await failureOf(stale, sent[0]?.code ?? '')).toEqual({
      status: 409,
      reason: 'expired',
      recovery: 'request-new-code',
    })
  })

  it('out of tries: start over', async () => {
    const id = await challengeId()
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await submit(id, '000000')

    expect(await failureOf(id, sent[0]?.code ?? '')).toEqual({
      status: 429,
      reason: 'attempts-exhausted',
      recovery: 'start-over',
    })
  })

  it('no such challenge: start over', async () => {
    const gone = '00000000-0000-0000-0000-000000000000'

    expect(await failureOf(gone, '000000')).toEqual({
      status: 404,
      reason: 'no-challenge',
      recovery: 'start-over',
    })
  })

  it('an id that is not an id gets the same answer as one that is gone', async () => {
    expect(await failureOf('not-a-uuid', '000000')).toEqual({
      status: 404,
      reason: 'no-challenge',
      recovery: 'start-over',
    })
  })

  it('keeps used and wrong apart, because only one of them means somebody else got in', async () => {
    const used = await challengeId('k1')
    await submit(used, sent[0]?.code ?? '')
    const open = await challengeId('k2')

    const a = await failureOf(used, '000000')
    const b = await failureOf(open, '000000')

    expect(a.reason).not.toBe(b.reason)
  })

  it('never says which part of the code was right', async () => {
    const id = await challengeId()
    const right = sent[0]?.code ?? ''
    const nearMiss = `${right.slice(0, 5)}${right[5] === '0' ? '1' : '0'}`

    expect(await failureOf(id, nearMiss)).toEqual(await failureOf(id, '999999'))
  })
})
