import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { credentialApi } from './credential-api.ts'
import { meApi } from './me-api.ts'
import { SESSION_COOKIE } from './session.ts'
import { signInApi, type SendCode } from './sign-in-api.ts'
import { connect, type Database } from '../db/connection.ts'
import { loadEnv } from '../env.ts'

const env = loadEnv()
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

/** Fresh per test: addresses and request keys are unique across the whole database. */
let RUN = ''

beforeEach(() => {
  RUN = randomUUID()
})

let lastCode = ''
const sendCode: SendCode = async (_to, code) => {
  lastCode = code
  return 'sent'
}

const deps = { db, secret: env.AUTH_SECRET, sendCode }
const auth = signInApi({ ...deps, providers: ['google', 'github'] })
const app = credentialApi(deps)
const me = meApi({ db, providers: ['google', 'github'] })

/** Signs somebody in the way a browser would, and returns the cookie it was handed. */
async function signedIn(address: string): Promise<string> {
  const opened = await auth.request('/auth/email-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: address, requestKey: `in-${address}` }),
  })
  const { codeId } = (await opened.json()) as { codeId: string }

  const answered = await auth.request(`/auth/email-codes/${codeId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: lastCode }),
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
  return app.request(`/me/credentials/email-codes/${id}/answer`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ code }),
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
    const added = await answer(codeId, lastCode, cookie)

    expect(added.status).toBe(204)
    expect(await opensWith(cookie)).toEqual([first, second])
  })

  it('refuses an address that already opens somebody else, and moves nothing', async () => {
    const mina = await signedIn(`mina-${RUN}@example.com`)
    const ruiAddress = `rui-${RUN}@example.com`
    const rui = await signedIn(ruiAddress)

    const { codeId } = (await (await ask(ruiAddress, mina)).json()) as { codeId: string }
    const taken = await answer(codeId, lastCode, mina)

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

    const opened = await auth.request('/auth/email-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: elsewhere, requestKey: `crossed-${RUN}` }),
    })
    const { codeId } = (await opened.json()) as { codeId: string }
    const crossed = await answer(codeId, lastCode, cookie)

    expect(crossed.status).toBe(404)
    expect(await crossed.json()).toMatchObject({ reason: 'no-code' })
  })
})
