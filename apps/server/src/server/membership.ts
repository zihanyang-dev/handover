/** Turning the Space in a path into the one this person is actually in. */

import { createMiddleware } from 'hono/factory'
import type { Database } from '../db/connection.ts'
import { spaceForMember, type Space } from '../db/space.ts'
import { body, type Failure } from './failure.ts'
import type { Signed } from './session.ts'

export type InSpace = { space: Space }

/**
 * A Space that is not there and a Space you are not in get the same answer, on purpose: otherwise
 * the address bar becomes a way to find out what exists.
 */
const UNAVAILABLE: Failure<404> = { reason: 'unavailable', recovery: 'start-over', status: 404 }

/**
 * Refuses anything about a Space this person is not in.
 *
 * A gate rather than a lookup each route repeats. Written out per route it was four copies of the
 * same two lines, and the one that eventually forgot them would be the one nobody noticed.
 *
 * Runs after {@link requireSession}, which is what puts the person in the request.
 */
export function requireMember(db: Database) {
  return createMiddleware<{ Variables: Signed & InSpace }>(async (c, next) => {
    // Unreachable by construction: every route this is mounted on has a `{slug}`. It is an
    // assertion rather than a fallback because the only way here is a wiring mistake, and that
    // should be a loud one in the log — not a 404 telling somebody their Space is missing.
    const slug = c.req.param('slug')
    if (slug === undefined) throw new Error('requireMember is mounted where there is no {slug}')

    const space = await spaceForMember(db, slug, c.get('userId'))

    if (space === undefined) return c.json(body(UNAVAILABLE), UNAVAILABLE.status)

    c.set('space', space)
    await next()
    return undefined
  })
}
