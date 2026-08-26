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
import { signInApi, type SignInApi } from './sign-in-api.ts'
import { HASHED, hashedFiles, thePage, wantsAPage } from './browser-app.ts'
import { api, SHOWS } from './contract.ts'
import { body, BROKEN, NOT_A_ROUTE } from './failure.ts'
import { SESSION_COOKIE } from './session.ts'
import { oauthApi, type OAuthApi } from './oauth-api.ts'
import { requestLog, type Logged } from './request-log.ts'
import { meApi } from './me-api.ts'
import { spaceApi } from './space-api.ts'
import { credentialApi } from './credential-api.ts'
import { approvalApi } from './approval-api.ts'
import { enrolmentApi } from './enrolment-api.ts'
import { conversationApi } from './conversation-api.ts'
import { machineApi } from './machine-api.ts'
import { liveApi } from './live-api.ts'
import type { Live } from '../conversation/live.ts'

/** What the whole surface needs. `providers` is read off the clients, so it cannot disagree. */
export type App = Omit<SignInApi, 'providers'> &
  Omit<OAuthApi, 'db' | 'secret'> & {
    readonly log: Log
    /** Where moments go while a turn runs. Nothing here is kept; see `conversation/live.ts`. */
    readonly live: Live
    /**
     * Where the built browser app is, when this process serves it too.
     *
     * Said rather than optional, so every composition root decides: a deployment that leaves it
     * out has put the pages somewhere else on the same origin, and that is a choice somebody made
     * rather than a line they forgot.
     */
    readonly webRoot: string | undefined
  }

/** The document a client is generated from, built from the routes and nothing else. */
export const CONTRACT = {
  openapi: '3.1.0',
  info: { title: 'Handover', version: '0' },
} as const

export function handoverApp(deps: App) {
  const providers = Object.keys(deps.clients) as Provider[]
  const app = api<{ Variables: Logged }>()
  app.use('*', requestLog(deps.log))

  // The two credentials this system has, said once for the whole document. Each door names the
  // one it asks for; this is where the contract learns what those names mean.
  app.openAPIRegistry.registerComponent('securitySchemes', SHOWS.session, {
    type: 'apiKey',
    in: 'cookie',
    name: SESSION_COOKIE,
    description: 'The cookie a browser gets by signing in. Never read by anything but a browser.',
  })
  app.openAPIRegistry.registerComponent('securitySchemes', SHOWS.machine, {
    type: 'http',
    scheme: 'bearer',
    description: 'The credential a machine mints for itself when it is let into a Space.',
  })

  // Before the routes, and only these: a name under here is a built file, and a request for one
  // that does not exist falls through to the same answer everything else gets.
  if (deps.webRoot !== undefined) app.use(HASHED, hashedFiles(deps.webRoot))

  // Stated rather than chained: `notFound` and `onError` answer for the whole app, not for the
  // route before them, and chaining would also drop what the routes said about themselves.
  const page = deps.webRoot === undefined ? undefined : thePage(deps.webRoot)
  app.notFound(async (c) => {
    // A person's address bar gets the app, which knows its own addresses; everything else gets a
    // refusal it can read. An API answering a navigation with JSON is a blank screen.
    const shown = page !== undefined && wantsAPage(c) ? await page(c) : undefined

    return shown ?? c.json(body(NOT_A_ROUTE), NOT_A_ROUTE.status)
  })
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
    .route('/', signInApi({ ...deps, providers }))
    .route('/', oauthApi(deps))
    .route('/', meApi({ db: deps.db, providers }))
    .route('/', spaceApi(deps.db))
    .route('/', credentialApi(deps))
    .route('/', enrolmentApi({ db: deps.db, webOrigin: deps.webOrigin }))
    .route('/', approvalApi({ db: deps.db }))
    .route('/', machineApi({ db: deps.db }))
    .route('/', conversationApi({ db: deps.db }))
    .route('/', liveApi({ db: deps.db, live: deps.live }))
}
