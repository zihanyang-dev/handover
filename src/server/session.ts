/** Turning the cookie a browser sends into the person it belongs to. */

import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { userHolding } from '../db/browser-session.ts'
import type { Database } from '../db/connection.ts'
import { hashSessionToken } from '../identity/browser-session.ts'
import { body, NO_SESSION } from './failure.ts'

export const SESSION_COOKIE = 'handover_session'

export type Signed = { userId: string }

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
