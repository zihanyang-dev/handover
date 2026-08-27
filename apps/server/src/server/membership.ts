/** Turning the Space in a path into the one this person is actually in. */

import { createMiddleware } from 'hono/factory'
import type { Database } from '../db/connection.ts'
import { isOwner } from '../db/membership.ts'
import { spaceForMember, type Space } from '../db/space.ts'
import { body, UNAVAILABLE, type Failure } from './failure.ts'
import type { Signed } from './session.ts'

export type InSpace = { space: Space }

/** Standing in the room, but this one is not theirs to do. */
const NOT_YOURS: Failure<403> = {
  reason: 'not-an-owner',
  recovery: 'ask-an-owner',
  status: 403,
}

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

/**
 * The same door, and then one more question: may this person do an owner's job.
 *
 * Mounted rather than asked inside a handler, for the same reason membership is: a check written
 * out per route is a check one route is written without, and that one is a member quietly able to
 * take somebody else out.
 *
 * The answer to "you are not an owner" is 403 and not 404. Membership already hid whether the
 * Space exists; by here that is known, and somebody standing in the room can be told plainly that
 * this one is not theirs to do.
 */
export function requireOwner(db: Database) {
  return createMiddleware<{ Variables: Signed & InSpace }>(async (c, next) => {
    if (!(await isOwner(db, c.get('space').id, c.get('userId')))) {
      return c.json(body(NOT_YOURS), NOT_YOURS.status)
    }

    await next()
    return undefined
  })
}
