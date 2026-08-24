import { afterAll, describe, expect, it } from 'vitest'
import { connect, type Database } from '../db/connection.ts'
import { loadEnv } from '../env.ts'
import { pino } from 'pino'
import { LOG_OPTIONS } from '../log.ts'
import { handoverApp } from './app.ts'
import type { SendCode } from './auth-api.ts'

const env = loadEnv()
const db: Database = connect(env)

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
const app = handoverApp({
  db,
  secret: env.AUTH_SECRET,
  sendCode: throwing,
  log,
  origin: 'http://localhost:3000',
  clients: { google: unreachable, github: unreachable },
})

afterAll(async () => {
  await db.destroy()
})

describe('when something breaks that no route planned for', () => {
  it('answers in the same shape as every other failure', async () => {
    const response = await app.request('/auth/email/challenges', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mina@example.com', requestKey: 'k1' }),
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ reason: 'unavailable', recovery: 'retry-later' })
  })

  it('writes what broke to the log, where it belongs', async () => {
    written.length = 0

    await app.request('/auth/email/challenges', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mina@example.com', requestKey: 'k3' }),
    })

    expect(written.join('')).toContain(SECRET_IN_THE_MESSAGE)
  })

  it('tells the caller nothing about what broke', async () => {
    const response = await app.request('/auth/email/challenges', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mina@example.com', requestKey: 'k2' }),
    })

    // An error message carries whatever the thrower put in it, and that is never the caller's.
    expect(await response.text()).not.toContain(SECRET_IN_THE_MESSAGE)
  })
})

describe('a request that never parsed', () => {
  it('is refused the same way wherever it arrives', async () => {
    const bad = { method: 'POST', headers: { 'content-type': 'application/json' } }

    const toChallenges = await app.request('/auth/email/challenges', {
      ...bad,
      body: JSON.stringify({ email: 'not-an-address', requestKey: 'k1' }),
    })
    expect(toChallenges.status).toBe(400)
    expect(await toChallenges.json()).toEqual({ reason: 'malformed-request', recovery: 'retype' })
  })

  it('learns nothing about the shape of a route it is not allowed to call', async () => {
    const bad = { method: 'POST', headers: { 'content-type': 'application/json' } }

    const nonsense = await app.request('/spaces', { ...bad, body: JSON.stringify({}) })
    const fine = await app.request('/spaces', {
      ...bad,
      body: JSON.stringify({ displayName: 'Acme', requestKey: 'k1' }),
    })

    // Who is asking is settled before what they sent is looked at, so a stranger cannot use the
    // validator to find out which fields a route wants.
    expect(nonsense.status).toBe(401)
    expect(await nonsense.json()).toEqual(await fine.json())
  })
})

describe('a path that is not a route', () => {
  it('says so in the shape everything else uses', async () => {
    const response = await app.request('/nothing-here')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ reason: 'no-such-route', recovery: 'start-over' })
  })
})
