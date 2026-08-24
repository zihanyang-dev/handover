/**
 * Leaving for a provider and coming back.
 *
 * Everything the round trip has to remember rides in one short-lived signed cookie: which
 * provider, what it was for, the `state` and PKCE verifier that prove the browser coming back is
 * the one that left, and where to put it afterwards. None of that is read from the URL, because
 * the URL is what an attacker gets to write.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono, type Context } from 'hono'
import { deleteCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie'
import { z } from 'zod'
import type { Database } from '../db/connection.ts'
import { connectProvider, signInWithProvider } from '../db/provider-sign-in.ts'
import { LIFETIME_DAYS, newSessionToken } from '../identity/browser-session.ts'
import type { Provider } from '../identity/provider.ts'
import { body, refuse, type Failure } from './failure.ts'
import { returnPath } from './return-path.ts'
import type { ProviderClient } from './oauth/provider-client.ts'
import { currentUser, requireSession, SESSION_COOKIE, type Signed } from './session.ts'

const HANDOFF_COOKIE = 'handover_oauth'

/** Long enough to sign in over there, short enough that a forgotten tab cannot be picked up. */
const HANDOFF_SECONDS = 600

/** One name carries whatever the round trip has to say, so a page reads one thing. */
const RESULT = 'handover_result'

const PROVIDERS = ['google', 'github'] as const

/** Asked for by name, but this deployment was given no keys for it. */
const NO_SUCH_PROVIDER: Failure = {
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

const named = z.object({ provider: z.enum(PROVIDERS) })

/**
 * A name that is not a provider gets the same answer as a provider without keys. Both mean there
 * is no way in by that name, the person does the same thing next, and neither answer is allowed
 * to describe the route it refused.
 */
const unknownProvider = (result: { success: boolean }): void => {
  if (!result.success) refuse(NO_SUCH_PROVIDER)
}

export type OAuthApi = {
  readonly db: Database
  readonly secret: string
  readonly origin: string
  /** Only the providers this deployment has keys for. The rest are not offered at all. */
  readonly clients: Readonly<Partial<Record<Provider, ProviderClient>>>
}

function back(to: string, result?: string): string {
  if (result === undefined) return to
  const separator = to.includes('?') ? '&' : '?'
  return `${to}${separator}${RESULT}=${encodeURIComponent(result)}`
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

  // The provider says the person said no. Nothing happened, and nothing should look like it did.
  if (returned.searchParams.get('error') !== null) return { to: back(to, 'cancelled') }

  const client = deps.clients[taken.provider]
  if (client === undefined) return { to: back(to, 'expired') }

  const found = await client.identify({
    url: returned,
    state: taken.state,
    pkceVerifier: taken.pkceVerifier,
  })
  if (found.kind === 'no-verified-email') return { to: back(to, 'no-verified-email') }

  if (taken.purpose === 'connect') {
    // The session that started this has to still be the session finishing it.
    if (currentUser === undefined) return { to: back(to, 'expired') }

    const connected = await connectProvider(deps.db, currentUser, found.identity)
    return { to: back(to, connected.kind === 'connected' ? undefined : connected.rejection) }
  }

  const session = newSessionToken()
  const arrived = await signInWithProvider(deps.db, found.identity, session.hash)
  return { to: back(to, arrived.merged ? 'merged' : undefined), sessionToken: session.token }
}

async function leave(
  c: Context,
  deps: OAuthApi,
  leaving: { provider: Provider; purpose: Handoff['purpose']; next: string | undefined },
): Promise<Response> {
  const { provider, purpose } = leaving
  const client = deps.clients[provider]
  if (client === undefined) return c.json(body(NO_SUCH_PROVIDER), NO_SUCH_PROVIDER.status)

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

  return c.redirect(begun.url.href, 303)
}

export function oauthApi(deps: OAuthApi) {
  const signedIn = requireSession(deps.db)

  return new Hono<{ Variables: Signed }>()
    .post(
      '/auth/:provider/start',
      zValidator('param', named, unknownProvider),
      zValidator('json', asked),
      async (c) =>
        leave(c, deps, {
          provider: c.req.valid('param').provider,
          purpose: 'sign-in',
          next: c.req.valid('json').next,
        }),
    )

    .post(
      '/me/sign-in-methods/:provider/start',
      signedIn,
      zValidator('param', named, unknownProvider),
      zValidator('json', asked),
      async (c) =>
        leave(c, deps, {
          provider: c.req.valid('param').provider,
          purpose: 'connect',
          next: c.req.valid('json').next,
        }),
    )

    .get('/auth/:provider/callback', zValidator('param', named, unknownProvider), async (c) => {
      const taken = await takeHandoff(c, deps.secret)
      // No handoff, or one belonging to a different provider: this arrival did not start here.
      if (taken === undefined || taken.provider !== c.req.valid('param').provider) {
        return c.redirect(back('/', 'expired'), 303)
      }

      const outcome = await settle(deps, taken, new URL(c.req.url), await currentUser(deps.db, c))

      if (outcome.sessionToken !== undefined) {
        setCookie(c, SESSION_COOKIE, outcome.sessionToken, {
          httpOnly: true,
          sameSite: 'Lax',
          path: '/',
          secure: new URL(c.req.url).protocol === 'https:',
          maxAge: LIFETIME_DAYS * 24 * 60 * 60,
        })
      }
      return c.redirect(outcome.to, 303)
    })
}
