/**
 * The whole HTTP surface, and what happens when something outside it goes wrong.
 *
 * `onError` is the reason this exists rather than the two route files being mounted separately:
 * whatever breaks — a database that went away, an adapter that threw where it promised not to —
 * has to leave by the same door, saying the same thing, and saying nothing about itself.
 */

import { HTTPException } from 'hono/http-exception'
import type { Provider } from '../identity/provider.ts'
import type { Log } from '../log.ts'
import { authApi, type AuthApi } from './auth-api.ts'
import { api } from './contract.ts'
import { body, BROKEN, NOT_A_ROUTE } from './failure.ts'
import { oauthApi, type OAuthApi } from './oauth-api.ts'
import { requestLog, type Logged } from './request-log.ts'
import { spaceApi } from './space-api.ts'
import { waysInApi } from './ways-in-api.ts'

/** What the whole surface needs. `providers` is read off the clients, so it cannot disagree. */
export type App = Omit<AuthApi, 'providers'> &
  Omit<OAuthApi, 'db' | 'secret'> & { readonly log: Log }

/** The document a client is generated from, built from the routes and nothing else. */
export const CONTRACT = {
  openapi: '3.1.0',
  info: { title: 'Handover', version: '0' },
} as const

export function handoverApp(deps: App) {
  const providers = Object.keys(deps.clients) as Provider[]
  const app = api<{ Variables: Logged }>()
  app.use('*', requestLog(deps.log))

  // Stated rather than chained: `notFound` and `onError` answer for the whole app, not for the
  // route before them, and chaining would also drop what the routes said about themselves.
  app.notFound((c) => c.json(body(NOT_A_ROUTE), NOT_A_ROUTE.status))
  app.onError((error, c) => {
    // Hono throws these for things it refuses on our behalf — a payload too large, a malformed
    // request line. They already carry a status a caller can act on, and calling that a fault of
    // ours would turn somebody's 413 into a 500.
    if (error instanceof HTTPException) return error.getResponse()

    // The whole error goes to the log and none of it to the response: a message carries whatever
    // the thrower put in it, and that is never the caller's to read.
    c.get('log').error({ err: error }, 'unhandled')
    return c.json(body(BROKEN), BROKEN.status)
  })

  return app
    .route('/', authApi({ ...deps, providers }))
    .route('/', oauthApi(deps))
    .route('/', spaceApi({ db: deps.db, providers }))
    .route('/', waysInApi(deps))
}
