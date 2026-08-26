/**
 * Writing the API contract out.
 *
 * The document is built from the app itself, so it cannot describe a route that is not there or
 * miss one that is. Nothing it is wired with is ever called — a spec is read off the routes, not
 * produced by serving anything.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from '../src/db/connection.ts'
import { loadEnv, type Env } from '../src/env.ts'
import { createLog } from '../src/log.ts'
import { CONTRACT, handoverApp } from '../src/server/app.ts'
import { waitingRoom } from '../src/server/waiting.ts'
import { ROOT } from './run-command.ts'

export function writeContract(env: Env): void {
  const app = handoverApp({
    db: connect(env),
    secret: env.AUTH_SECRET,
    sendCode: async () => 'sent',
    log: createLog(env),
    origin: env.PUBLIC_ORIGIN,
    webOrigin: env.WEB_ORIGIN,
    clients: {},
    // Nothing is ever called: a spec is read off the routes, not produced by serving anything.
    live: { say: async () => undefined, watch: () => () => undefined },
    // A contract is read off the routes, and pages are not routes.
    webRoot: undefined,
    waiting: waitingRoom(0),
    lettersPerCallerPerHour: env.LETTERS_PER_CALLER_PER_HOUR,
    trustedProxyHops: env.TRUSTED_PROXY_HOPS,
  })

  const document = app.getOpenAPIDocument(CONTRACT)
  writeFileSync(join(ROOT, 'generated', 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`)
}

if (process.argv[1] === import.meta.filename) writeContract(loadEnv())
