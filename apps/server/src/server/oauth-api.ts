/**
 * Leaving for a provider and coming back.
 *
 * Everything the round trip has to remember rides in one short-lived signed cookie: which
 * provider, what it was for, the `state` and PKCE verifier that prove the browser coming back is
 * the one that left, and where to put it afterwards. None of that is read from the URL, because
 * the URL is what an attacker gets to write.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import type { Database } from '../db/connection.ts'
import { connectProvider } from '../db/credential.ts'
import { signInWithProvider } from '../db/sign-in.ts'
import { newSessionToken } from '../identity/session.ts'
import { PROVIDERS, type Provider } from '../identity/provider.ts'
import { api, endpointsBehind, saysNothing, sends, takes } from './contract.ts'
import { BEHIND_A_SESSION, MALFORMED_BODY, body, refusal, type Failure } from './failure.ts'
import type { ProviderClient } from './oauth/provider-client.ts'
import { returnPath } from './return-path.ts'
import {
  currentUser,
  overHttps,
  requireSession,
  sessionHeld,
  startSession,
  type Signed,
} from './session.ts'

const HANDOFF_COOKIE = 'handover_oauth'

/** Long enough to sign in over there, short enough that a forgotten tab cannot be picked up. */
const HANDOFF_SECONDS = 600

/** One name carries whatever the round trip has to say, so a page reads one thing. */
const RESULT = 'handover_result'

/** Asked for by name, but this deployment was given no keys for it. */
const NO_SUCH_PROVIDER: Failure<404> = {
  reason: 'provider-unavailable',
  recovery: 'start-over',
  status: 404,
}

const handoff = z.object({
  provider: z.enum(PROVIDERS),
  purpose: z.enum(['sign-in', 'connect']),
  state: z.string().min(1),
  pkceVerifier: z.string().min(1),
  next: z.string(),
  /**
   * Which session started this, for a trip that connects a way in to an account.
   *
   * The account is decided when the browser comes back, and "whoever is signed in now" is not the
   * same person: sign out and in as somebody else mid-trip and the provider credential lands on
   * their account. The hash, so a cookie that leaks is not a session token.
   */
  startedBy: z.string().optional(),
})

type Handoff = z.infer<typeof handoff>

const asked = z.object({ next: z.string().optional() })

/**
 * Not an enum. Whether a name is a way in is answered by looking for its client — a made-up name
 * and a real one this deployment has no keys for are the same situation, and asking twice would
 * only create two ways to answer it.
 */
const named = z.object({ provider: z.string() })

/**
 * The URL to go to, not a redirect to it. A page reading a 303 with `fetch` cannot see where it
 * points — the browser hides the target of an opaque redirect — and following it would send the
 * request itself to the provider instead of the person. Navigating is the browser's job.
 */
const handoffBody = z.object({ url: z.url() }).openapi('Handoff')

export type OAuthApi = {
  readonly db: Database
  readonly secret: string
  /** Where a provider is told to send the browser back to. Registered over there, so it is fixed. */
  readonly origin: string
  /** Where the browser is sent once the trip is over. Not always the same place. */
  readonly webOrigin: string
  /** Only the providers this deployment has keys for. The rest are not offered at all. */
  readonly clients: Readonly<Partial<Record<Provider, ProviderClient>>>
}

/**
 * Where to put the browser down. `path` has already been through {@link returnPath}, so it names
 * somewhere on the app and not somewhere else entirely.
 */
function back(webOrigin: string, path: string, result?: string): string {
  const landing = new URL(path, webOrigin)
  if (result !== undefined) landing.searchParams.set(RESULT, result)
  return landing.href
}

/** Reads the handoff and spends it: a round trip is good once, whatever it ends in. */
async function takeHandoff(c: Context, secret: string): Promise<Handoff | undefined> {
  const raw = await getSignedCookie(c, secret, HANDOFF_COOKIE)
  deleteCookie(c, HANDOFF_COOKIE, { path: '/' })
  if (typeof raw !== 'string') return undefined

  const parsed = handoff.safeParse(JSON.parse(raw))
  return parsed.success ? parsed.data : undefined
}

type Outcome = { readonly to: string; readonly sessionToken?: string }

/**
 * What the round trip amounted to.
 *
 * Every path ends at a page rather than at a status code, because the browser got here by being
 * redirected and there is nobody to read a body.
 */
async function settle(
  deps: OAuthApi,
  taken: Handoff,
  returned: URL,
  /** Who is signed in on the browser that came back, and which session that is. */
  browser: { readonly userId: string | undefined; readonly session: string | undefined },
): Promise<Outcome> {
  const to = returnPath(taken.next, deps.webOrigin)
  const landing = (result?: string) => back(deps.webOrigin, to, result)

  // The provider says the person said no. Nothing happened, and nothing should look like it did.
  if (returned.searchParams.get('error') !== null) return { to: landing('cancelled') }

  const found = wayIn(deps, taken.provider)
  if (found === undefined) return { to: landing('expired') }

  const identified = await found.client.identify({
    url: returned,
    state: taken.state,
    pkceVerifier: taken.pkceVerifier,
  })
  if (identified.kind === 'no-verified-email') return { to: landing('no-verified-email') }

  if (taken.purpose === 'connect') {
    // The session that started this has to be the session finishing it — not merely some session.
    // Compared by the token this browser is holding, because that is the only thing that says the
    // person who left is the person who came back.
    const same = taken.startedBy !== undefined && taken.startedBy === browser.session
    if (browser.userId === undefined || !same) return { to: landing('expired') }

    const connected = await connectProvider(deps.db, browser.userId, identified.identity)
    return { to: landing(connected.kind === 'connected' ? undefined : connected.rejection) }
  }

  const session = newSessionToken()
  const signedIn = await signInWithProvider(deps.db, identified.identity, session.hash)
  return { to: landing(signedIn.merged ? 'merged' : undefined), sessionToken: session.token }
}

/**
 * The one place a name becomes a provider. A name nobody recognises and a provider this
 * deployment has no keys for come out the same: nothing.
 */
function wayIn(deps: OAuthApi, name: string) {
  const provider = PROVIDERS.find((known) => known === name)
  if (provider === undefined) return undefined

  const client = deps.clients[provider]
  return client === undefined ? undefined : { provider, client }
}

/** Remembers the trip and says where to send the browser, or nothing if there is no such way in. */
async function leave(
  c: Context,
  deps: OAuthApi,
  leaving: {
    name: string
    purpose: Handoff['purpose']
    next: string | undefined
    startedBy: string | undefined
  },
): Promise<{ url: string } | undefined> {
  const found = wayIn(deps, leaving.name)
  if (found === undefined) return undefined

  const { provider, client } = found
  const { purpose } = leaving
  const begun = await client.begin(`${deps.origin}/auth/${provider}/callback`)

  const remembered: Handoff = {
    provider,
    purpose,
    state: begun.state,
    pkceVerifier: begun.pkceVerifier,
    next: returnPath(leaving.next, deps.webOrigin),
    ...(leaving.startedBy === undefined ? {} : { startedBy: leaving.startedBy }),
  }

  await setSignedCookie(c, HANDOFF_COOKIE, JSON.stringify(remembered), deps.secret, {
    httpOnly: true,
    // Lax, not Strict: the browser comes back from the provider by following a redirect, and
    // Strict would withhold the cookie on exactly that arrival.
    sameSite: 'Lax',
    path: '/',
    secure: overHttps(deps.webOrigin),
    maxAge: HANDOFF_SECONDS,
  })

  return { url: begun.url.href }
}

/**
 * Every leg of the round trip, whether or not a session is involved: coming back has to work for
 * a browser that is not signed in yet, which is the whole point of going.
 */
const trip = endpointsBehind<{ Variables: Signed }>()

export function oauthApi(deps: OAuthApi) {
  return api<{ Variables: Signed }>().openapiRoutes([
    leavingToSignIn(deps),
    leavingToConnect(deps),
    comingBack(deps),
  ])
}

/** Leaving with nobody signed in, which is how somebody becomes signed in. */
function leavingToSignIn(deps: OAuthApi) {
  return trip({
    route: createRoute({
      method: 'post',
      path: '/auth/{provider}/start',
      summary: 'Leave to sign in with a provider',
      request: { params: named, body: takes(asked) },
      responses: {
        ...MALFORMED_BODY,
        200: sends(handoffBody, 'Send the browser here'),
        404: refusal('No way in by that name'),
      },
    }),

    handler: async (c) => {
      const sent = await leave(c, deps, {
        name: c.req.valid('param').provider,
        purpose: 'sign-in',
        next: c.req.valid('json').next,
        // Nobody is signed in yet, and that is what this trip is for. There is no session to bind.
        startedBy: undefined,
      })
      if (sent === undefined) return c.json(body(NO_SUCH_PROVIDER), NO_SUCH_PROVIDER.status)
      return c.json(sent, 200)
    },
  })
}

/** Leaving as somebody, to come back with one more way of proving it is them. */
function leavingToConnect(deps: OAuthApi) {
  return trip({
    route: createRoute({
      method: 'post',
      path: '/me/credentials/{provider}/start',
      summary: 'Leave to connect a provider to this account',
      middleware: [requireSession(deps.db)],
      request: { params: named, body: takes(asked) },
      responses: {
        ...BEHIND_A_SESSION,
        ...MALFORMED_BODY,
        200: sends(handoffBody, 'Send the browser here'),
        404: refusal('No way in by that name'),
      },
    }),

    handler: async (c) => {
      const sent = await leave(c, deps, {
        name: c.req.valid('param').provider,
        purpose: 'connect',
        next: c.req.valid('json').next,
        startedBy: sessionHeld(c),
      })
      if (sent === undefined) return c.json(body(NO_SUCH_PROVIDER), NO_SUCH_PROVIDER.status)
      return c.json(sent, 200)
    },
  })
}

/** Coming back, which always ends at a page: the browser was redirected, so nobody reads a body. */
function comingBack(deps: OAuthApi) {
  return trip({
    route: createRoute({
      method: 'get',
      path: '/auth/{provider}/callback',
      summary: 'Where the provider sends the browser back to',
      request: { params: named },
      responses: {
        303: saysNothing('Follow the Location; any `handover_result` says what became of the trip'),
        404: refusal('No way in by that name'),
      },
    }),

    handler: async (c) => {
      const taken = await takeHandoff(c, deps.secret)
      // No handoff, or one belonging to a different provider: this arrival did not start here.
      if (taken === undefined || taken.provider !== c.req.valid('param').provider) {
        return c.redirect(back(deps.webOrigin, '/', 'expired'), 303)
      }

      const outcome = await settle(deps, taken, new URL(c.req.url), {
        userId: await currentUser(deps.db, c),
        session: sessionHeld(c),
      })

      if (outcome.sessionToken !== undefined) {
        startSession(c, outcome.sessionToken, deps.webOrigin)
      }
      return c.redirect(outcome.to, 303)
    },
  })
}
