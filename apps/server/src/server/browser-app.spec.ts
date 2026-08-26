import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pino } from 'pino'
import { LOG_OPTIONS } from '../log.ts'
import { handoverApp, type App } from './app.ts'
import { waitingRoom } from './waiting.ts'
import { connect, type Database } from '../db/connection.ts'
import { loadEnv } from '../env.ts'

const env = loadEnv()
const db: Database = connect(env)

afterAll(async () => {
  await db.destroy()
})

/** A built browser app, as the build really lays one out: one page, and hashed files beside it. */
let WEB = ''

beforeAll(async () => {
  WEB = await mkdtemp(join(tmpdir(), 'handover-web-'))
  await mkdir(join(WEB, 'assets'), { recursive: true })
  await writeFile(join(WEB, 'index.html'), '<!doctype html><title>Handover</title>')
  await writeFile(join(WEB, 'assets', 'index-abc123.js'), 'console.log(1)\n')
})

const unreachable = {
  begin: () => {
    throw new Error('not reached in these tests')
  },
  identify: () => {
    throw new Error('not reached in these tests')
  },
}

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
