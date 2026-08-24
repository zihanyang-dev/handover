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
import { api, saysNothing, sends, takes } from './contract.ts'
import { body, refusal, type Failure } from './failure.ts'
import type { ProviderClient } from './oauth/provider-client.ts'
import { returnPath } from './return-path.ts'
import { currentUser, requireSession, startSession, type Signed } from './session.ts'

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

const startSignIn = createRoute({
  method: 'post',
  path: '/auth/{provider}/start',
  summary: 'Leave to sign in with a provider',
  request: { params: named, body: takes(asked) },
  responses: {
    200: sends(handoffBody, 'Send the browser here'),
    400: refusal('The body was not the shape it claims'),
    404: refusal('No way in by that name'),
  },
})

const startConnect = createRoute({
  method: 'post',
  path: '/me/credentials/{provider}/start',
  summary: 'Leave to connect a provider to this account',
  request: { params: named, body: takes(asked) },
  responses: {
    200: sends(handoffBody, 'Send the browser here'),
    400: refusal('The body was not the shape it claims'),
    401: refusal('Nobody is signed in here'),
    404: refusal('No way in by that name'),
  },
})

const comeBack = createRoute({
  method: 'get',
  path: '/auth/{provider}/callback',
  summary: 'Where the provider sends the browser back to',
  request: { params: named },
  responses: {
    303: saysNothing('Follow the Location; any `handover_result` says what became of the trip'),
    404: refusal('No way in by that name'),
  },
})

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
  currentUser: string | undefined,
): Promise<Outcome> {
  const to = returnPath(taken.next)
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
    // The session that started this has to still be the session finishing it.
    if (currentUser === undefined) return { to: landing('expired') }

    const connected = await connectProvider(deps.db, currentUser, identified.identity)
    return { to: landing(connected.kind === 'connected' ? undefined : connected.rejection) }
  }

  const session = newSessionToken()
  const arrived = await signInWithProvider(deps.db, identified.identity, session.hash)
  return { to: landing(arrived.merged ? 'merged' : undefined), sessionToken: session.token }
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
  leaving: { name: string; purpose: Handoff['purpose']; next: string | undefined },
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
    next: returnPath(leaving.next),
  }

  await setSignedCookie(c, HANDOFF_COOKIE, JSON.stringify(remembered), deps.secret, {
    httpOnly: true,
    // Lax, not Strict: the browser comes back from the provider by following a redirect, and
    // Strict would withhold the cookie on exactly that arrival.
    sameSite: 'Lax',
    path: '/',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: HANDOFF_SECONDS,
  })

  return { url: begun.url.href }
}

export function oauthApi(deps: OAuthApi) {
  const signedIn = requireSession(deps.db)

  return api<{ Variables: Signed }>()
    .openapi(startSignIn, async (c) => {
      const sent = await leave(c, deps, {
        name: c.req.valid('param').provider,
        purpose: 'sign-in',
        next: c.req.valid('json').next,
      })
      if (sent === undefined) return c.json(body(NO_SUCH_PROVIDER), NO_SUCH_PROVIDER.status)
      return c.json(sent, 200)
    })

    .openapi({ ...startConnect, middleware: [signedIn] }, async (c) => {
      const sent = await leave(c, deps, {
        name: c.req.valid('param').provider,
        purpose: 'connect',
        next: c.req.valid('json').next,
      })
      if (sent === undefined) return c.json(body(NO_SUCH_PROVIDER), NO_SUCH_PROVIDER.status)
      return c.json(sent, 200)
    })

    .openapi(comeBack, async (c) => {
      const taken = await takeHandoff(c, deps.secret)
      // No handoff, or one belonging to a different provider: this arrival did not start here.
      if (taken === undefined || taken.provider !== c.req.valid('param').provider) {
        return c.redirect(back(deps.webOrigin, '/', 'expired'), 303)
      }

      const outcome = await settle(deps, taken, new URL(c.req.url), await currentUser(deps.db, c))

      if (outcome.sessionToken !== undefined) {
        startSession(c, outcome.sessionToken)
      }
      return c.redirect(outcome.to, 303)
    })
}
