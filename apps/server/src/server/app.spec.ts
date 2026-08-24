import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import { pino } from 'pino'
import { LOG_OPTIONS } from '../log.ts'
import { handoverApp } from './app.ts'
import type { SendCode } from './sign-in-api.ts'
import { connect, type Database } from '../db/connection.ts'
import { loadEnv } from '../env.ts'

/** Fresh per test: a request key is unique across the whole table. */
let RUN = ''

beforeEach(() => {
  RUN = randomUUID()
})

const env = loadEnv()
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

const SECRET_IN_THE_MESSAGE = 'smtp://user:hunter2@mail.example.com'

const throwing: SendCode = () => {
  throw new Error(`could not reach ${SECRET_IN_THE_MESSAGE}`)
}
const written: string[] = []
const log = pino(LOG_OPTIONS, { write: (line: string) => written.push(line) })
const unreachable = {
  begin: () => {
    throw new Error('not reached in these tests')
  },
  identify: () => {
    throw new Error('not reached in these tests')
  },
}
const deps = {
  db,
  secret: env.AUTH_SECRET,
  sendCode: throwing,
  log,
  origin: 'http://localhost:3000',
  webOrigin: 'http://localhost:5173',
  clients: { google: unreachable, github: unreachable },
}
const app = handoverApp(deps)

describe('when something breaks that no route planned for', () => {
  it('answers in the same shape as every other failure', async () => {
    const response = await app.request('/auth/email-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `mina-${RUN}@example.com`, requestKey: `${RUN}-k1` }),
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ reason: 'unavailable', recovery: 'retry-later' })
  })

  it('writes what broke to the log, where it belongs', async () => {
    written.length = 0

    await app.request('/auth/email-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `mina-${RUN}@example.com`, requestKey: `${RUN}-k3` }),
    })

    expect(written.join('')).toContain(SECRET_IN_THE_MESSAGE)
  })

  it('tells the caller nothing about what broke', async () => {
    const response = await app.request('/auth/email-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `mina-${RUN}@example.com`, requestKey: `${RUN}-k2` }),
    })

    // An error message carries whatever the thrower put in it, and that is never the caller's.
    expect(await response.text()).not.toContain(SECRET_IN_THE_MESSAGE)
  })
})

describe('a request that never parsed', () => {
  it('is refused the same way wherever it arrives', async () => {
    const bad = { method: 'POST', headers: { 'content-type': 'application/json' } }

    const toCodes = await app.request('/auth/email-codes', {
      ...bad,
      body: JSON.stringify({ email: 'not-an-address', requestKey: `${RUN}-k1` }),
    })
    expect(toCodes.status).toBe(400)
    expect(await toCodes.json()).toEqual({ reason: 'malformed-request', recovery: 'retype' })
  })

  it('learns nothing about the shape of a route it is not allowed to call', async () => {
    const bad = { method: 'POST', headers: { 'content-type': 'application/json' } }

    const nonsense = await app.request('/spaces', { ...bad, body: JSON.stringify({}) })
    const fine = await app.request('/spaces', {
      ...bad,
      body: JSON.stringify({ displayName: 'Acme', requestKey: `${RUN}-k1` }),
    })

    // Who is asking is settled before what they sent is looked at, so a stranger cannot use the
    // validator to find out which fields a route wants.
    expect(nonsense.status).toBe(401)
    expect(await nonsense.json()).toEqual(await fine.json())
  })
})

describe('a refusal Hono made on our behalf', () => {
  it('keeps the status it came with, rather than becoming our fault', async () => {
    const refusing: SendCode = () => {
      throw new HTTPException(413, { message: 'too big' })
    }
    const strict = handoverApp({ ...deps, sendCode: refusing })

    const response = await strict.request('/auth/email-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `mina-${RUN}@example.com`, requestKey: `${RUN}-k9` }),
    })

    expect(response.status).toBe(413)
  })
})

describe('a path that is not a route', () => {
  it('says so in the shape everything else uses', async () => {
    const response = await app.request('/nothing-here')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ reason: 'no-such-route', recovery: 'start-over' })
  })
})
