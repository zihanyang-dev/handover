/**
 * The whole HTTP surface, and what happens when something outside it goes wrong.
 *
 * `onError` is the reason this exists rather than the two route files being mounted separately:
 * whatever breaks — a database that went away, an adapter that threw where it promised not to —
 * has to leave by the same door, saying the same thing, and saying nothing about itself.
 */

import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Provider } from '../identity/provider.ts'
import type { Log } from '../log.ts'
import { authApi, type AuthApi } from './auth-api.ts'
import { body, BROKEN, NOT_A_ROUTE } from './failure.ts'
import { oauthApi, type OAuthApi } from './oauth-api.ts'
import { requestLog, type Logged } from './request-log.ts'
import { spaceApi } from './space-api.ts'

export type App = AuthApi & Omit<OAuthApi, 'db' | 'secret'> & { readonly log: Log }

export function handoverApp(deps: App) {
  return new Hono<{ Variables: Logged }>()
    .use('*', requestLog(deps.log))
    .route('/', authApi(deps))
    .route('/', oauthApi(deps))
    .route('/', spaceApi({ db: deps.db, providers: Object.keys(deps.clients) as Provider[] }))
    .notFound((c) => c.json(body(NOT_A_ROUTE), NOT_A_ROUTE.status))
    .onError((error, c) => {
      // A refusal that already decided how it looks. Anything else is ours, not the caller's.
      if (error instanceof HTTPException) return error.getResponse()

      // The whole error goes to the log and none of it to the response: a message carries
      // whatever the thrower put in it, and that is never the caller's to read.
      c.get('log').error({ err: error }, 'unhandled')
      return c.json(body(BROKEN), BROKEN.status)
    })
}
