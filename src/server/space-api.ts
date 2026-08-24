/**
 * What a signed-in person can do: see who they are, rename themselves, make a Space, enter one.
 *
 * Every route here is behind a live session, so "who is asking" is never a parameter and never
 * something a caller can claim.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import { z } from 'zod'
import { revokeSession } from '../db/browser-session.ts'
import type { Database } from '../db/connection.ts'
import { createSpace, spaceForMember, spacesOf } from '../db/space.ts'
import { personById, renamePerson } from '../db/user.ts'
import { hashSessionToken } from '../identity/browser-session.ts'
import type { Provider } from '../identity/provider.ts'
import { waysIn } from '../identity/ways-in.ts'
import { normalizeSlug } from '../space/slug.ts'
import { body, MALFORMED, refuse, type Failure } from './failure.ts'
import { requireSession, SESSION_COOKIE, type Signed } from './session.ts'

/** A Space that is not there and a Space you are not in are the same answer, on purpose. */
const UNAVAILABLE: Failure = { reason: 'unavailable', recovery: 'start-over', status: 404 }

const UNUSABLE_NAME: Failure = {
  reason: 'unusable-name',
  recovery: 'choose-another-name',
  status: 400,
}

const malformed = (result: { success: boolean }): void => {
  if (!result.success) refuse(MALFORMED)
}

const newSpace = z.object({
  displayName: z.string().min(1).max(200),
  requestKey: z.string().min(1).max(200),
})

const newName = z.object({ displayName: z.string().min(1).max(200) })

/**
 * Chained, not statement by statement: that is what carries the route types to an RPC client.
 *
 * Each route names the session it needs instead of one `use('*')` covering them all. A wildcard
 * mounted at the root swallows every path in the whole app — including the sign-in routes, which
 * escaped only by being registered first. Nothing that important should rest on ordering.
 */
export type SpaceApi = {
  readonly db: Database
  /** The providers this deployment actually has keys for. */
  readonly providers: readonly Provider[]
}

export function spaceApi({ db, providers }: SpaceApi) {
  const signedIn = requireSession(db)

  return new Hono<{ Variables: Signed }>()
    .get('/me', signedIn, async (c) => {
      const person = await personById(db, c.get('userId'))
      // The session named somebody the database no longer has. Nothing to be signed in as.
      if (person === undefined) return c.json(body(UNAVAILABLE), UNAVAILABLE.status)

      return c.json({
        displayName: person.displayName,
        verifiedEmail: person.verifiedEmail,
        waysIn: waysIn(person.connected, providers),
        spaces: await spacesOf(db, person.id),
      })
    })

    .patch('/me', signedIn, zValidator('json', newName, malformed), async (c) => {
      await renamePerson(db, c.get('userId'), c.req.valid('json').displayName.trim())
      return c.body(null, 204)
    })

    .post('/spaces', signedIn, zValidator('json', newSpace, malformed), async (c) => {
      const asked = c.req.valid('json')
      const slug = normalizeSlug(asked.displayName)
      // A name of pure punctuation has no address, and no address means no Space.
      if (slug === null) return c.json(body(UNUSABLE_NAME), UNUSABLE_NAME.status)

      const made = await createSpace(db, {
        requestKey: asked.requestKey,
        userId: c.get('userId'),
        displayName: asked.displayName.trim(),
        slug,
      })

      if (made.kind === 'slug-taken') {
        const taken = { reason: 'slug-taken', recovery: 'choose-another-name' } as const
        return c.json({ ...taken, suggestion: made.suggestion }, 409)
      }
      return c.json(made.space, made.kind === 'created' ? 201 : 200)
    })

    .get('/spaces/:slug', signedIn, async (c) => {
      const space = await spaceForMember(db, c.req.param('slug'), c.get('userId'))
      if (space === undefined) return c.json(body(UNAVAILABLE), UNAVAILABLE.status)
      return c.json(space)
    })

    .delete('/browser/sessions/current', signedIn, async (c) => {
      const token = getCookie(c, SESSION_COOKIE)
      if (token !== undefined) await revokeSession(db, hashSessionToken(token))
      deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.body(null, 204)
    })
}
