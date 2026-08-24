/**
 * Starting the server, and stopping it without dropping anything.
 *
 * Stopping matters as much as starting. A deploy replaces instances constantly, and one that
 * exits the moment it is asked to cuts off whatever requests it was in the middle of — including
 * a transaction that had committed but whose answer never reached the browser.
 */

import { serve } from '@hono/node-server'
import { connect } from './db/connection.ts'
import { CREDENTIALS, loadEnv } from './env.ts'
import { createLog } from './log.ts'
import { PROVIDERS, type Provider } from './identity/provider.ts'
import { handoverApp } from './server/app.ts'
import type { SendCode } from './server/auth-api.ts'
import { githubClient } from './server/oauth/github.ts'
import { googleClient } from './server/oauth/google.ts'
import type { ProviderClient } from './server/oauth/provider-client.ts'

/** How long in-flight requests get to finish before this stops waiting for them. */
const GRACE_MS = 10_000

const env = loadEnv()
const log = createLog(env)

// There is no mail provider yet, and the stand-in puts the code where the logs are. That is fine
// while the only reader is whoever is running it, and never fine anywhere else.
if (env.NODE_ENV === 'production') {
  log.fatal('no mail provider is configured; refusing to start')
  process.exit(1)
}

const sendCode: SendCode = async (to, code) => {
  log.warn({ to, plainCode: code }, 'no mail provider: the code is only here')
  return 'sent'
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
  const [idKey, secretKey] = CREDENTIALS[provider]
  const id = env[idKey]
  const secret = env[secretKey]
  if (id !== undefined && secret !== undefined)
    clients[provider] = await BUILD[provider](id, secret)
}
log.info({ providers: Object.keys(clients) }, 'sign-in providers')

const db = connect(env)
const app = handoverApp({
  db,
  secret: env.AUTH_SECRET,
  sendCode,
  log,
  origin: env.PUBLIC_ORIGIN,
  webOrigin: env.WEB_ORIGIN,
  clients,
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

  const drained = new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, GRACE_MS).unref())
  await Promise.race([drained, deadline])

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
