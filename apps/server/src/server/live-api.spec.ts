/**
 * The live stream, as bytes.
 *
 * The screen tests for this half all run against a stand-in `EventSource` that hands a callback
 * whatever a test says the server sent — so they prove what a page does with an event and nothing
 * about whether one ever arrives. Everything between the two, which is most of it, was unwalked:
 * the notify that crosses instances, the hub that finds the right watchers, and the stream itself.
 *
 * So this reads the response body. No browser, no double: the same `text/event-stream` a browser
 * would parse, asserted on the wire.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { normalizeSlug, type Slug } from '@handover/universal'
import { enrolmentApi } from './enrolment-api.ts'
import { approvalApi } from './approval-api.ts'
import { machineApi } from './machine-api.ts'
import { waitingRoom } from './waiting.ts'
import { liveApi } from './live-api.ts'
import { SESSION_COOKIE } from './session.ts'
import { connect, type Database } from '../db/connection.ts'
import { handTo, liveThrough, listenForLive } from '../db/live.ts'
import type { Watched } from '../conversation/live.ts'
import { openConversation } from '../db/conversation.ts'
import { createSpace } from '../db/space.ts'
import { openSession } from '../db/session.ts'
import { newSessionToken } from '../identity/session.ts'
import { arrive } from '../db/user.ts'
import { loadEnv } from '../env.ts'
import { LOG_OPTIONS } from '../log.ts'
import { pino } from 'pino'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'

const env = loadEnv()
const db: Database = connect(env)
const log = pino({ ...LOG_OPTIONS, level: 'silent' })

/** The same wiring `main.ts` does: a map of watchers, and the connection that feeds it. */
const watching = new Map<string, Set<(watched: Watched) => void>>()
const listening = listenForLive(env, log, (happening) => {
  handTo(watching, happening)
})
const live = liveThrough(db, watching)

const enrolments = enrolmentApi({ db, webOrigin: 'http://localhost:5173' }).route(
  '/',
  approvalApi({ db }),
)
const machines = machineApi({ db, waiting: waitingRoom(0) })
const app = liveApi({ db, live })

afterAll(async () => {
  await listening.stop()
  await db.destroy()
})

let RUN = ''
let SLUG = ''
let COOKIE = ''
let TOKEN = ''
let CONVERSATION = ''

beforeEach(async () => {
  await listening.listening
  RUN = randomUUID()
  const address = `ilya-${RUN}@example.com`
  const arrived = await db
    .transaction()
    .execute(async (tx) =>
      arrive(tx, { kind: 'email', subject: address }, { name: null, username: null, address }),
    )

  const session = newSessionToken()
  await openSession(db, { user: arrived.userId, tokenHash: session.hash })
  COOKIE = `${SESSION_COOKIE}=${session.token}`

  const name = `Acme ${RUN.slice(0, 8)}`
  SLUG = normalizeSlug(name) as string
  const made = await createSpace(db, {
    requestKey: `space-${RUN}`,
    userId: arrived.userId,
    displayName: name,
    slug: SLUG as Slug,
  })
  if (made.kind !== 'created') throw new Error('the fixture could not make a Space')

  TOKEN = `hm_${randomUUID()}`
  const asked = (await (
    await enrolments.request('/enrolments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineName: 'ilya-mbp' }),
    })
  ).json()) as { secret: string; userCode: string }
  await enrolments.request('/me/machines', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    body: JSON.stringify({ userCode: asked.userCode }),
  })
  const collected = (await (
    await enrolments.request('/enrolments/collect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: asked.secret, machineName: 'ilya-mbp', token: TOKEN }),
    })
  ).json()) as { machineId: string }

  // The agent has to be on the machine before a conversation can be opened on it, and what says
  // so is the machine reporting what it found.
  await machines.request('/machines/current/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ found: [{ command: 'claude', version: '2.1.231' }] }),
  })

  const opened = await openConversation(db, {
    spaceId: made.space.id,
    machineId: collected.machineId,
    agentKind: 'claude-code',
  })
  if (opened.kind !== 'opened') throw new Error('the fixture could not open a conversation')
  CONVERSATION = opened.conversationId
})

/**
 * The same app, behind the HTTP server it really runs behind.
 *
 * `app.request` never leaves the process, so it cannot see whether a stream is written through to
 * a socket or held in a buffer somewhere between Hono and node — which is the whole of what a
 * browser depends on.
 */
async function overHttp(): Promise<{ origin: string; stop: () => Promise<void> }> {
  const server = serve({ fetch: app.fetch, port: 0 })
  await new Promise((ready) => server.once('listening', ready))
  const { port } = server.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    stop: async () => {
      await new Promise((closed) => {
        server.close(() => {
          closed(undefined)
        })
      })
    },
  }
}

/** Opens the stream and hands back a reader over the text a browser would be parsing. */
async function watch(): Promise<{ read: () => Promise<string>; close: () => Promise<void> }> {
  const answered = await app.request(`/spaces/${SLUG}/conversations/${CONVERSATION}/live`, {
    headers: { cookie: COOKIE },
  })

  expect(answered.status).toBe(200)
  expect(answered.headers.get('content-type')).toContain('text/event-stream')

  const reader = (answered.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()

  return {
    read: async () => {
      const chunk = await reader.read()
      return chunk.done ? '' : decoder.decode(chunk.value)
    },
    close: async () => {
      await reader.cancel()
    },
  }
}

describe('watching a conversation', () => {
  it('carries a moment from a machine to whoever is looking', async () => {
    const stream = await watch()

    try {
      await app.request(`/machines/current/conversations/${CONVERSATION}/live`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ said: 'thinking', text: 'looking for notes.txt' }),
      })

      expect(await stream.read()).toContain('looking for notes.txt')
    } finally {
      await stream.close()
    }
  }, 20_000)

  it('carries somebody else having the box open', async () => {
    // The same channel, said by a person rather than a machine. It is the one thing on here that
    // one person sends and another sees, so it is the one that proves the hub finds the right
    // watchers rather than only the sender.
    const stream = await watch()

    try {
      const said = await app.request(`/spaces/${SLUG}/conversations/${CONVERSATION}/typing`, {
        method: 'POST',
        headers: { cookie: COOKIE },
      })
      expect(said.status).toBe(204)

      expect(await stream.read()).toContain('typing')
    } finally {
      await stream.close()
    }
  }, 20_000)

  it('is written through the HTTP server, not held in a buffer behind it', async () => {
    // The one thing neither the screen tests nor the in-process read can see. A stream that is
    // correct in Hono and never flushed by node is a product whose live half does not exist.
    const http = await overHttp()

    try {
      const answered = await fetch(
        `${http.origin}/spaces/${SLUG}/conversations/${CONVERSATION}/live`,
        { headers: { cookie: COOKIE } },
      )
      expect(answered.status).toBe(200)

      const reader = (answered.body as ReadableStream<Uint8Array>).getReader()
      await app.request(`/machines/current/conversations/${CONVERSATION}/live`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ said: 'thinking', text: 'over the socket' }),
      })

      const chunk = await reader.read()
      expect(new TextDecoder().decode(chunk.value)).toContain('over the socket')
      await reader.cancel()
    } finally {
      await http.stop()
    }
  }, 20_000)
})
