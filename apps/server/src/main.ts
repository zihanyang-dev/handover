/**
 * Starting the server, and stopping it without dropping anything.
 *
 * Stopping matters as much as starting. A deploy replaces instances constantly, and one that
 * exits the moment it is asked to cuts off whatever requests it was in the middle of — including
 * a transaction that had committed but whose answer never reached the browser.
 */

import { serve } from '@hono/node-server'
import { connect } from './db/connection.ts'
import { handTo, listenForLive, liveThrough } from './db/live.ts'
import { listenForWaking } from './db/waking.ts'
import { POLL_SECONDS } from './machine/presence.ts'
import { waitingRoom } from './server/waiting.ts'
import type { Watched } from './conversation/live.ts'
import { PROVIDER_KEYS, loadEnv } from './env.ts'
import { codeLetter } from './identity/email-code.ts'
import { createLog } from './log.ts'
import { resend, type Mailer } from './mail.ts'
import { PROVIDERS, type Provider } from './identity/provider.ts'
import { handoverApp } from './server/app.ts'
import { keepWaking } from './server/waker.ts'
import type { SendCode } from './server/email-code.ts'
import { githubClient } from './server/oauth/github.ts'
import { googleClient } from './server/oauth/google.ts'
import type { ProviderClient } from './server/oauth/provider-client.ts'

/** How long in-flight requests get to finish before this stops waiting for them. */
const GRACE_MS = 10_000

const env = loadEnv()
const log = createLog(env)

// Without a key the code goes to the log, which is fine while the only reader is whoever is
// running it, and never fine anywhere else. Allowed only where the environment says development
// out loud — `NODE_ENV` has no default, so nothing gets here by having said nothing.
if (env.RESEND_API_KEY === undefined && env.NODE_ENV !== 'development') {
  log.fatal('no mail provider is configured; refusing to start')
  process.exit(1)
}

const deliver: Mailer =
  env.RESEND_API_KEY === undefined
    ? async (letter) => {
        log.warn(
          { to: letter.to, plainLetter: letter.text },
          'no mail provider: the letter is only here',
        )
        return 'sent'
      }
    : resend(env)

// The route answers the same way whatever comes back, so this is the only place the outcome is
// ever written down. A refusal that nobody logged is a person waiting for a letter that will
// never arrive, and no way to find out why.
const sendCode: SendCode = async (to, code) => {
  const delivery = await deliver({ to, ...codeLetter(code) })
  if (delivery !== 'sent') log.error({ to, delivery }, 'the code may not have arrived')
  return delivery
}

/**
 * How each provider's client is made. Required, one entry per provider: adding a name without
 * saying how to build it is a compile error, not a way in that quietly never appears.
 *
 * The values are the hand-written modules, not rows in a table. Google discovers its endpoints
 * over the network and GitHub does not, and that difference belongs in those files rather than in
 * a shape they both have to be squeezed into.
 */
const BUILD = {
  google: googleClient,
  github: async (id: string, secret: string) => githubClient(id, secret),
} as const satisfies Record<Provider, (id: string, secret: string) => Promise<ProviderClient>>

/** Built at startup, so an unreachable provider is found now and not at somebody's first sign-in. */
const clients: Partial<Record<Provider, ProviderClient>> = {}
for (const provider of PROVIDERS) {
  const [idKey, secretKey] = PROVIDER_KEYS[provider]
  const id = env[idKey]
  const secret = env[secretKey]
  if (id !== undefined && secret !== undefined)
    clients[provider] = await BUILD[provider](id, secret)
}
log.info({ providers: Object.keys(clients) }, 'sign-in providers')

const db = connect(env)

/**
 * Everyone watching a turn on this instance, and the connection that hears about turns running on
 * the others. A moment is worth nothing a second later, so none of this is kept anywhere.
 */
const watching = new Map<string, Set<(watched: Watched) => void>>()
const listening = listenForLive(env, log, (happening) => {
  handTo(watching, happening)
})

/**
 * The machine questions this instance is holding, and the line that tells it when to answer one.
 *
 * A machine cannot be reached, so it asks; holding its question is what turns "the next time it
 * asks" into "now". The waking crosses instances through Postgres, because the machine may be
 * held here while the person who has something for it is talking to another instance.
 */
const waiting = waitingRoom(POLL_SECONDS)
const waking = listenForWaking(env, log, (machineId) => {
  waiting.wake(machineId)
})

/**
 * The one thing on this side that starts on its own.
 *
 * Everything else here answers somebody: a browser, a machine, another instance. A moment that
 * has come has nobody to answer, so something has to look.
 */
const waker = keepWaking(db, log)

const app = handoverApp({
  db,
  secret: env.AUTH_SECRET,
  sendCode,
  log,
  origin: env.PUBLIC_ORIGIN,
  webOrigin: env.WEB_ORIGIN,
  clients,
  live: liveThrough(db, watching),
  waiting,
  webRoot: env.WEB_ROOT,
  lettersPerCallerPerHour: env.LETTERS_PER_CALLER_PER_HOUR,
  trustedProxyHops: env.TRUSTED_PROXY_HOPS,
})

const server = serve({ fetch: app.fetch, port: env.PORT }, (address) => {
  log.info({ port: address.port }, 'listening')
})

let stopping = false

async function stop(signal: string): Promise<void> {
  // A second signal is somebody impatient, not a second shutdown.
  if (stopping) return
  stopping = true
  log.info({ signal }, 'stopping')

  // Before anything is closed: a held question is an open connection, and draining one means
  // waiting out the hold. Answered now, its machine asks again and lands wherever it lands.
  waiting.wakeEveryone()

  const drained = new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, GRACE_MS).unref())
  await Promise.race([drained, deadline])

  waker.stop()

  // Their own connections, so they are their own to close.
  await listening.stop()
  await waking.stop()

  // Last, and only once nothing is still using it: closing the pool under a live request would
  // fail it after its transaction had already committed.
  await db.destroy()
  log.info('stopped')
  process.exit(0)
}

process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))

// Node's own handling for these prints something unstructured and, for a rejection, may not exit
// at all. Neither is acceptable in a fleet: a log nobody can group, or an instance still taking
// traffic in a state nothing has reasoned about.
process.on('uncaughtException', (error) => {
  log.fatal({ err: error }, 'uncaught exception')
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled rejection')
  process.exit(1)
})
