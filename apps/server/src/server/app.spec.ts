import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import { pino } from 'pino'
import { LOG_OPTIONS } from '../log.ts'
import { handoverApp } from './app.ts'
import { SHOWS } from './contract.ts'
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

/** The contract as it is published: written by `pnpm generate`, committed, read by both clients. */
const CONTRACT_FILE = join(import.meta.dirname, '..', '..', 'generated', 'openapi.json')

/** What an error message really looks like when something upstream fails with a URL in hand. */
const WHERE_IT_BROKE = 'smtp://user:hunter2@mail.example.com'

const throwing: SendCode = () => {
  throw new Error(`could not reach ${WHERE_IT_BROKE}`)
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
  live: { say: async () => undefined, watch: () => () => undefined },
  lettersPerCallerPerHour: 500,
  trustedProxyHops: 0,
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

    // What broke and where, without the part that opens it. Field-name redaction cannot reach
    // inside a message, and a log outlives the request that made it by months.
    expect(written.join('')).toContain('mail.example.com')
    expect(written.join('')).not.toContain('hunter2')
  })

  it('tells the caller nothing about what broke', async () => {
    const response = await app.request('/auth/email-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `mina-${RUN}@example.com`, requestKey: `${RUN}-k2` }),
    })

    // An error message carries whatever the thrower put in it, and that is never the caller's.
    expect(await response.text()).not.toContain('mail.example.com')
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

describe('what the contract says about who may call what', () => {
  /**
   * Every operation in the published contract, with the credential it says a caller has to show.
   *
   * Read off the file rather than out of the app, because the file is what a client is generated
   * from and what anybody reads. `pnpm check` rebuilds it before this runs and fails on any diff,
   * so it cannot be stale here.
   */
  function everyEndpoint(): readonly {
    at: string
    shows: readonly string[]
    answers: readonly number[]
  }[] {
    const document = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8')) as {
      paths: Record<
        string,
        Record<
          string,
          {
            security?: readonly Record<string, unknown>[]
            responses: Record<string, unknown>
          }
        >
      >
    }

    const endpoints = []
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const shows = (operation.security ?? []).flatMap((one) => Object.keys(one))
        const answers = Object.keys(operation.responses).map(Number)
        endpoints.push({ at: `${method.toUpperCase()} ${path}`, shows, answers })
      }
    }

    return endpoints
  }

  it('names a machine credential on every path only a machine can use', async () => {
    // The path says who it is for — `/machines/current/…` is a machine talking about itself — and
    // the door has to agree. One mounted behind the wrong door would be a browser able to write
    // an agent's half of a transcript, which no amount of care at the handler can undo.
    const machines = everyEndpoint().filter((one) => one.at.includes(' /machines/current/'))

    expect(machines.length).toBeGreaterThan(0)
    for (const one of machines) expect([one.at, one.shows]).toEqual([one.at, [SHOWS.machine]])
  })

  it('names a session on every path that belongs to a person', async () => {
    const people = everyEndpoint().filter(
      (one) => one.at.includes(' /spaces') || one.at.includes(' /me'),
    )

    expect(people.length).toBeGreaterThan(0)
    for (const one of people) expect([one.at, one.shows]).toEqual([one.at, [SHOWS.session]])
  })

  it('says a Space you are not in is one that is not there, on every path inside one', async () => {
    // The membership door answers both with the same 404, so that a URL cannot be used to find
    // out which Spaces exist. A route that declared only a 401 would be telling a client the
    // difference is knowable, and the first client to act on that turns the address bar into a
    // way of asking.
    const inASpace = everyEndpoint().filter((one) => one.at.includes('/spaces/{slug}'))

    expect(inASpace.length).toBeGreaterThan(0)
    for (const one of inASpace) expect([one.at, one.answers.includes(404)]).toEqual([one.at, true])
  })

  it('leaves open only the ways in, which are the ones nobody can have a credential for yet', async () => {
    // Everything else has to be behind something. This is the list somebody has to change on
    // purpose — and the reason to make it hard is that adding a route is easy.
    const open = everyEndpoint()
      .filter((one) => one.shows.length === 0)
      .map((one) => one.at)
      .sort()

    expect(open).toEqual([
      'GET /auth/credentials',
      'GET /auth/{provider}/callback',
      'POST /auth/email-codes',
      'POST /auth/email-codes/{id}/answer',
      'POST /auth/{provider}/start',
      'POST /enrolments',
      'POST /enrolments/collect',
    ])
  })
})
