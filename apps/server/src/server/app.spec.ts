import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HTTPException } from 'hono/http-exception'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { connect, type Database } from '../db/connection.ts'
import { loadEnv } from '../env.ts'
import { LOG_OPTIONS } from '../log.ts'
import { waitingRoom } from '../machine/waiting.ts'
import type { ObjectStore } from '../object-store.ts'
import { handoverApp, type App } from './app.ts'
import type { SendCode } from './credential-api.ts'

/** Fresh per test: a request key is unique per asker, and these tests share an asker. */
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

/** No route under test reads a face, so the store answers as an empty bucket would. */
const noBucket: ObjectStore = {
  find: async () => undefined,
  put: async () => undefined,
  close: () => undefined,
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
  webRoot: undefined,
  waiting: waitingRoom(0),
  objects: noBucket,
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
    expect(await response.json()).toEqual({
      reason: 'something-went-wrong',
      recovery: 'retry-later',
    })
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
      body: JSON.stringify({ displayName: 'Acme', emoji: '🏠', requestKey: `${RUN}-k1` }),
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

/** A built browser app, as the build really lays one out: one page, and hashed files beside it. */
let WEB = ''

beforeAll(async () => {
  WEB = await mkdtemp(join(tmpdir(), 'handover-web-'))
  await mkdir(join(WEB, 'assets'), { recursive: true })
  await writeFile(join(WEB, 'index.html'), '<!doctype html><title>Handover</title>')
  await writeFile(join(WEB, 'assets', 'index-abc123.js'), 'console.log(1)\n')
})

function serving(webRoot: string | undefined) {
  const deps: App = {
    db,
    secret: env.AUTH_SECRET,
    sendCode: async () => 'sent',
    log: pino(LOG_OPTIONS, { write: () => undefined }),
    origin: 'http://localhost:3000',
    webOrigin: 'http://localhost:3000',
    clients: { google: unreachable, github: unreachable },
    live: { say: async () => undefined, watch: () => () => undefined },
    lettersPerCallerPerHour: 500,
    trustedProxyHops: 0,
    webRoot,
    waiting: waitingRoom(0),
    objects: noBucket,
  }

  return handoverApp(deps)
}

/** What a browser sends when somebody types an address; a client calling an endpoint does not. */
const NAVIGATING = { headers: { accept: 'text/html,application/xhtml+xml' } }

describe('serving the browser app from the same origin', () => {
  it('answers the front door with the app', async () => {
    const response = await serving(WEB).request('/', NAVIGATING)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>Handover</title>')
  })

  it('answers an address only the page knows with the page, not with a refusal', async () => {
    // The routing lives over there. A 404 here would be this server claiming to know which
    // addresses the app has, and being wrong about it every time one is added.
    const response = await serving(WEB).request('/s/acme/c/17', NAVIGATING)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>Handover</title>')
  })

  it('never lets that page be kept, because it is what names the build', async () => {
    // Kept, a browser goes on asking for the assets of a build that is no longer deployed.
    const response = await serving(WEB).request('/', NAVIGATING)

    expect(response.headers.get('cache-control')).toBe('no-cache')
  })

  it('lets a hashed file be kept forever, because a change to it is a new name', async () => {
    const response = await serving(WEB).request('/assets/index-abc123.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('still refuses in JSON when whoever asked was not asking for a page', async () => {
    // The same address, and a different answer, decided by what the caller said it could read.
    const response = await serving(WEB).request('/s/acme/c/17')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ reason: 'no-such-route', recovery: 'start-over' })
  })

  it('leaves the API answering for itself, page or no page', async () => {
    // The pages are mounted behind every route, so one of them cannot shadow an endpoint — which
    // would be a machine getting HTML back from a check-in.
    const response = await serving(WEB).request('/auth/credentials', NAVIGATING)

    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('offered')
  })

  it('is an API and nothing else when this deployment does not serve the pages', async () => {
    // A deployment with a proxy or a CDN in front of the pages. Its refusals stay refusals.
    const response = await serving(undefined).request('/s/acme', NAVIGATING)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ reason: 'no-such-route', recovery: 'start-over' })
  })

  it('refuses rather than serving an empty page when pointed at the wrong directory', async () => {
    const response = await serving(join(WEB, 'nothing-here')).request('/', NAVIGATING)

    expect(response.status).toBe(404)
  })
})
