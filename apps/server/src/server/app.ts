/**
 * The whole HTTP surface: every module mounted, and everything this process answers that is not a
 * module's route — a request for no route at all, a fault, and the built browser app.
 *
 * `onError` is the reason the mounting lives here rather than in each module: whatever breaks — a
 * database that went away, an adapter that threw where it promised not to — has to leave by the
 * same door, saying the same thing, and saying nothing about itself.
 *
 * The pages are served from this same origin, and that is forced rather than chosen: the page's
 * calls carry no origin of their own, and its session cookie is `SameSite=Lax`. Served from
 * somewhere else, every call would be cross-site and every one of them would arrive signed out. A
 * deployment may still put a proxy or a CDN in front of the pages instead — then it leaves
 * `WEB_ROOT` unset and none of it mounts. What is not allowed is a second origin.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Live } from '../conversation/live.ts'
import type { Provider } from '../identity/provider.ts'
import type { Log } from '../log.ts'
import type { Waiting } from '../machine/waiting.ts'
import type { ObjectStore } from '../object-store.ts'
import { avatarApi } from './avatar-api.ts'
import { conversationApi } from './conversation-api.ts'
import { credentialApi, type CredentialApi } from './credential-api.ts'
import { enrolmentApi } from './enrolment-api.ts'
import { BROKEN, NOT_A_ROUTE, refused } from './failure.ts'
import { invitationApi } from './invitation-api.ts'
import { liveApi } from './live-api.ts'
import { machineApi } from './machine-api.ts'
import { meApi } from './me-api.ts'
import { memberApi } from './member-api.ts'
import { oauthApi, type OAuthApi } from './oauth-api.ts'
import { requestLog, type Logged } from './request-log.ts'
import { SHOWS, api, mounted } from './route.ts'
import { SESSION_COOKIE } from './session.ts'
import { spaceApi } from './space-api.ts'
import { taskApi } from './task-api.ts'

/** Everything the build writes under this name carries a hash of its contents; nothing else does. */
const HASHED = '/assets/*'

const FOREVER = 'public, max-age=31536000, immutable'

/**
 * Files whose names carry their own hash, kept for as long as any browser likes.
 *
 * A change to one of these is a new name, so nothing that is still being asked for can be stale.
 * It is the other half of {@link THE_PAGE}, and only safe because of it.
 */
function hashedFiles(root: string): MiddlewareHandler {
  const files = serveStatic({ root })

  return async (c, next) => {
    // Set on the way back rather than through `onFound`, which is measured: that hook is called
    // after the response has already been built, so a header set in it never reaches anybody.
    const served = await files(c, next)
    if (served === undefined) return undefined

    served.headers.set('Cache-Control', FOREVER)
    return served
  }
}

/**
 * The one file whose name never changes, and therefore the one that must never be kept.
 *
 * It is what names the hashed files. Cached, a browser goes on asking for the assets of a build
 * that is no longer deployed, and renders a page nobody can reproduce.
 */
const THE_PAGE = 'no-cache'

/**
 * Whether this request is a browser asking for a page.
 *
 * The one honest way to tell somebody's address bar from a client calling an endpoint that does
 * not exist: a navigation says it accepts HTML and a call for JSON does not. Both get answered,
 * with different things — the app for the first, a refusal it can read for the second.
 */
function wantsAPage(c: Context): boolean {
  return c.req.header('accept')?.includes('text/html') === true
}

/**
 * The app itself, for any address it owns.
 *
 * Which addresses those are is the page's to know, not this server's: the routing lives over
 * there. So every address that is not one of ours is handed to the app, including the ones it
 * will itself call unknown — and handed over as a page with a 200, because nothing is missing.
 * The app is what lives at that address.
 *
 * Nothing when the file is not there. A deployment pointed at the wrong directory should not
 * answer every request with an empty page for the rest of its life.
 */
function thePage(root: string) {
  return async (c: Context): Promise<Response | undefined> => {
    const html = await readFile(join(root, 'index.html'), 'utf8').catch(() => undefined)
    if (html === undefined) return undefined

    return c.html(html, 200, { 'Cache-Control': THE_PAGE })
  }
}

/** What the whole surface needs. `providers` is read off the clients, so it cannot disagree. */
export type App = Omit<CredentialApi, 'providers'> &
  Omit<OAuthApi, 'db' | 'secret'> & {
    readonly log: Log
    /** Where moments go while a turn runs. Nothing here is kept; see `conversation/live.ts`. */
    readonly live: Live
    /** The machine questions this instance is holding rather than answering with "nothing". */
    readonly waiting: Waiting
    /** Where a face is kept once it has been drawn. */
    readonly objects: ObjectStore
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

/**
 * The two credentials this system has, said once for the whole document.
 *
 * Each door names the one it asks for — see `route.ts`. This is where the contract learns what
 * those names mean.
 */
function theTwoCredentials(app: OpenAPIHono<{ Variables: Logged }>) {
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
}

export function handoverApp(deps: App) {
  const providers = Object.keys(deps.clients) as Provider[]
  const app = api<{ Variables: Logged }>()
  app.use('*', requestLog(deps.log))

  theTwoCredentials(app)

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

    return shown ?? refused(c, NOT_A_ROUTE)
  })
  app.onError((error, c) => {
    // Hono throws these for things it refuses on our behalf — a payload too large, a malformed
    // request line. They already carry a status a caller can act on, and calling that a fault of
    // ours would turn somebody's 413 into a 500.
    if (error instanceof HTTPException) return error.getResponse()

    // The whole error goes to the log and none of it to the response: a message carries whatever
    // the thrower put in it, and that is never the caller's to read.
    c.get('log').error({ err: error }, 'unhandled')
    return refused(c, BROKEN)
  })

  // In the order somebody meets them: get in, be somebody, make a Space, fill it with people and
  // machines, then talk to an agent and hand it work.
  return app
    .route('/', mounted(credentialApi({ ...deps, providers })))
    .route('/', mounted(oauthApi(deps)))
    .route('/', mounted(meApi({ db: deps.db, providers })))
    .route('/', mounted(spaceApi({ db: deps.db })))
    .route('/', mounted(invitationApi({ db: deps.db, webOrigin: deps.webOrigin })))
    .route('/', mounted(memberApi({ db: deps.db })))
    .route('/', mounted(enrolmentApi({ db: deps.db, webOrigin: deps.webOrigin })))
    .route('/', mounted(machineApi({ db: deps.db, waiting: deps.waiting })))
    .route('/', mounted(conversationApi({ db: deps.db })))
    .route('/', mounted(liveApi({ db: deps.db, live: deps.live })))
    .route('/', mounted(taskApi({ db: deps.db })))
    .route('/', mounted(avatarApi({ objects: deps.objects })))
}
