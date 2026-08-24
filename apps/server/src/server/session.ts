/** Turning the cookie a browser sends into the person it belongs to. */

import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { userHolding } from '../db/session.ts'
import type { Database } from '../db/connection.ts'
import { hashSessionToken, LIFETIME_DAYS } from '../identity/session.ts'
import { body, NO_SESSION } from './failure.ts'

export const SESSION_COOKIE = 'handover_session'

export type Signed = { userId: string }

/**
 * Puts a session in the browser's hands.
 *
 * Every way in ends here, so the cookie a code produces and the cookie a provider produces carry
 * the same protections. Written twice, one of them would eventually be tightened and the other
 * forgotten, and nothing would say which way in had become the weak one.
 */
export function startSession(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // Lax, not Strict: a browser coming back from a provider arrives by following a redirect,
    // and Strict would withhold the cookie on exactly that arrival.
    sameSite: 'Lax',
    path: '/',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: LIFETIME_DAYS * 24 * 60 * 60,
  })
}

/** The person this request is carrying a live session for, or nobody. Refuses no one. */
export async function currentUser(db: Database, c: Context): Promise<string | undefined> {
  const token = getCookie(c, SESSION_COOKIE)
  return token === undefined ? undefined : userHolding(db, hashSessionToken(token))
}

/**
 * Refuses everything that is not a live session. No cookie, an unknown token, a revoked one and
 * an expired one all get the same answer: whichever it was, the person signs in again, and
 * telling them which would only say whether a token was ever real.
 */
export function requireSession(db: Database) {
  return createMiddleware<{ Variables: Signed }>(async (c, next) => {
    const userId = await currentUser(db, c)

    if (userId === undefined) return c.json(body(NO_SESSION), NO_SESSION.status)

    c.set('userId', userId)
    await next()
    return undefined
  })
}
