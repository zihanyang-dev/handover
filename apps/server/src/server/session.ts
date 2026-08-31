/**
 * The cookie a browser signs in with: putting one there, reading it back, and what it means.
 *
 * Turning it into a refusal when it is missing is the gate's job, not this file's — see
 * `middleware.ts`.
 */

import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { Database } from '../db/connection.ts'
import { userHolding } from '../db/session.ts'
import { hashSessionToken, LIFETIME_DAYS } from '../identity/session.ts'

export const SESSION_COOKIE = 'handover_session'

/**
 * Puts a session in the browser's hands.
 *
 * Every way in ends here, so the cookie a code produces and the cookie a provider produces carry
 * the same protections. Written twice, one of them would eventually be tightened and the other
 * forgotten, and nothing would say which way in had become the weak one.
 */
export function startSession(c: Context, token: string, origin: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // Lax, not Strict: a browser coming back from a provider arrives by following a redirect,
    // and Strict would withhold the cookie on exactly that arrival.
    sameSite: 'Lax',
    path: '/',
    secure: overHttps(origin),
    maxAge: LIFETIME_DAYS * 24 * 60 * 60,
  })
}

/**
 * Whether a browser reaches this deployment over HTTPS.
 *
 * Read from the origin this deployment was configured with, never from the request: behind the
 * ordinary arrangement — TLS ends at a proxy and plain HTTP goes to this process — `c.req.url` is
 * `http:`, and a session cookie would go out without `Secure` on every production request.
 */
export function overHttps(origin: string): boolean {
  return URL.parse(origin)?.protocol === 'https:'
}

/**
 * Which session this browser is holding, as it is stored. Nobody, when it is holding none.
 *
 * The hash, never the token: this is written into a cookie of our own for the round trip through a
 * provider, and a cookie that carries a session token is a second copy of the session.
 */
export function sessionHeld(c: Context): string | undefined {
  const token = getCookie(c, SESSION_COOKIE)
  return token === undefined ? undefined : hashSessionToken(token)
}

/** The person this request is carrying a live session for, or nobody. Refuses no one. */
export async function currentUser(db: Database, c: Context): Promise<string | undefined> {
  const token = getCookie(c, SESSION_COOKIE)
  return token === undefined ? undefined : userHolding(db, hashSessionToken(token))
}
