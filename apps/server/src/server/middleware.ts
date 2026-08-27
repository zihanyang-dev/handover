/**
 * What runs before a handler, and what it leaves in the handler's hands.
 *
 * Five gates and the three things they put there. Which routes are behind which of them is not
 * decided here — a door is a way of declaring a route, and it lives with the rest of that
 * vocabulary in `route.ts`. This file knows nothing about routes.
 */

import { createMiddleware } from 'hono/factory'
import type { Database } from '../db/connection.ts'
import { machineHolding } from '../db/machine.ts'
import { isOwner } from '../db/membership.ts'
import { spaceForMember, type Space } from '../db/space.ts'
import { hashSecret } from '../secret.ts'
import { refused, UNAVAILABLE, type Failure } from './failure.ts'
import { currentUser } from './session.ts'

/** Somebody signed in, as the handler reads them. */
export type Signed = { userId: string }

/** A live machine credential, as the handler reads it. */
export type Attached = { machineId: string }

/** The Space in the path, already read and already known to be theirs. */
export type InSpace = { space: Space }

/**
 * Nobody is signed in here.
 *
 * No cookie, an unknown token, a revoked one and an expired one all get the same answer:
 * whichever it was, the person signs in again, and telling them which would only say whether a
 * token was ever real.
 */
const NO_SESSION: Failure<401> = { reason: 'no-session', recovery: 'sign-in', status: 401 }

/**
 * Nobody's machine.
 *
 * Separate from the answer a browser gets, because the recovery is different in kind: a person
 * signs in again, a machine has to be enrolled again by a person. Telling a machine to "sign in"
 * would be telling it to do something it cannot do.
 */
const NOT_A_MACHINE: Failure<401> = { reason: 'no-machine', recovery: 'start-over', status: 401 }

/** Standing in the room, but this one is not theirs to do. */
const NOT_YOURS: Failure<403> = { reason: 'not-an-owner', recovery: 'ask-an-owner', status: 403 }

/** Refuses everything that is not a live session. */
export function requireSession(db: Database) {
  return createMiddleware<{ Variables: Signed }>(async (c, next) => {
    const userId = await currentUser(db, c)
    if (userId === undefined) return refused(c, NO_SESSION)

    c.set('userId', userId)
    await next()
    return undefined
  })
}

/**
 * Refuses everything that is not a live machine credential.
 *
 * Deliberately does not accept a browser session. The two are different holders with different
 * powers — a machine may report what it found and take work, a person may read a Space and remove
 * machines — and one door that opened to both would be the weaker of the two everywhere.
 */
export function requireMachine(db: Database) {
  return createMiddleware<{ Variables: Attached }>(async (c, next) => {
    const machineId = await machineFrom(db, c.req.header('authorization'))
    if (machineId === undefined) return refused(c, NOT_A_MACHINE)

    c.set('machineId', machineId)
    await next()
    return undefined
  })
}

/** Which machine is holding this credential, or none. Anything but a live bearer is none. */
async function machineFrom(db: Database, authorization: string | undefined) {
  const bearer = authorization?.match(/^Bearer (?<token>\S+)$/u)?.groups?.['token']

  return bearer === undefined ? undefined : machineHolding(db, hashSecret(bearer))
}

/**
 * Refuses anything about a Space this person is not in.
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
    if (space === undefined) return refused(c, UNAVAILABLE)

    c.set('space', space)
    await next()
    return undefined
  })
}

/**
 * The same gate, and then one more question: may this person do an owner's job.
 *
 * The answer to "you are not an owner" is 403 and not 404. Membership already hid whether the
 * Space exists; by here that is known, and somebody standing in the room can be told plainly that
 * this one is not theirs to do.
 */
export function requireOwner(db: Database) {
  return createMiddleware<{ Variables: Signed & InSpace }>(async (c, next) => {
    if (!(await isOwner(db, c.get('space').id, c.get('userId')))) return refused(c, NOT_YOURS)

    await next()
    return undefined
  })
}

/**
 * An owner's job, unless the person it is about is the person asking.
 *
 * Leaving is removing aimed at yourself, and reading what is still yours is the list you are
 * shown before you press it. Behind {@link requireOwner} alone, a member cannot leave a Space at
 * all — they have to find an owner and ask to be thrown out.
 *
 * [GitHub lets any member remove themselves at any time](https://docs.github.com/en/account-and-profile/how-tos/organization-membership/removing-yourself-from-an-organization),
 * and the only person it stops is the last owner — stopped by the rule that a Space keeps one,
 * not by a permission. Ours is the same split: **this gate is about doing things to other
 * people.** The last owner is stopped a layer down, by the database.
 */
export function requireOwnerOrYourself(db: Database) {
  return createMiddleware<{ Variables: Signed & InSpace }>(async (c, next) => {
    // Unreachable by construction, and loud rather than quiet for the same reason `{slug}` is:
    // mounted where there is no `{userId}` this would silently become owners-only, and the
    // person who could no longer leave their own Space would have nothing to read about why.
    const about = c.req.param('userId')
    if (about === undefined) {
      throw new Error('requireOwnerOrYourself is mounted where there is no {userId}')
    }

    if (about !== c.get('userId') && !(await isOwner(db, c.get('space').id, c.get('userId')))) {
      return refused(c, NOT_YOURS)
    }

    await next()
    return undefined
  })
}
