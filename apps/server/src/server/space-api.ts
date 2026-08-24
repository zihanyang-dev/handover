/**
 * What a signed-in person can do: see who they are, rename themselves, make a Space, enter one.
 *
 * Every route here is behind a live session, so "who is asking" is never a parameter and never
 * something a caller can claim.
 */

import { createRoute, z } from '@hono/zod-openapi'
import { deleteCookie, getCookie } from 'hono/cookie'
import { revokeSession } from '../db/browser-session.ts'
import type { Database } from '../db/connection.ts'
import { createSpace, spaceForMember, spacesOf } from '../db/space.ts'
import { personById, renamePerson } from '../db/user.ts'
import { hashSessionToken } from '../identity/browser-session.ts'
import { PROVIDERS, type Provider } from '../identity/provider.ts'
import { waysIn } from '../identity/way-in.ts'
import { normalizeSlug } from '@handover/universal'
import { api, saysNothing, sends, takes } from './contract.ts'
import { body, refusal, type Failure } from './failure.ts'
import { requireSession, SESSION_COOKIE, type Signed } from './session.ts'

/** A Space that is not there and a Space you are not in are the same answer, on purpose. */
const UNAVAILABLE: Failure<404> = { reason: 'unavailable', recovery: 'start-over', status: 404 }

const UNUSABLE_NAME: Failure<400> = {
  reason: 'unusable-name',
  recovery: 'choose-another-name',
  status: 400,
}

const newSpace = z
  .object({
    displayName: z.string().min(1).max(200).openapi({ example: '徐悦泰 Studio' }),
    requestKey: z.string().min(1).max(200),
  })
  .openapi('NewSpace')

const newName = z.object({ displayName: z.string().min(1).max(200) }).openapi('NewDisplayName')

const spaceBody = z
  .object({ id: z.uuid(), slug: z.string(), displayName: z.string() })
  .openapi('Space')

/**
 * Two shapes, not one with an optional address, so nothing can render a provider row with an
 * address on it or an address row without one. An address is always ready — it is only here
 * because somebody proved it.
 */
const wayBody = z
  .union([
    z.object({
      kind: z.literal('email'),
      address: z.email(),
      state: z.literal('ready'),
    }),
    z.object({
      kind: z.enum(PROVIDERS),
      state: z.enum(['ready', 'connectable']),
    }),
  ])
  .openapi('WayIn')

const meBody = z
  .object({
    displayName: z.string(),
    // No single address: there is no such thing any more. Every one this account holds is a row
    // in `waysIn`, which is also the only place that says how many keys there are.
    waysIn: z.array(wayBody).readonly(),
    spaces: z.array(spaceBody).readonly(),
  })
  .openapi('Me')

const takenBody = z
  .object({
    reason: z.literal('slug-taken'),
    recovery: z.literal('choose-another-name'),
    suggestion: z.string().openapi({ example: 'acme-2' }),
  })
  .openapi('SlugTaken')

const whoAmI = createRoute({
  method: 'get',
  path: '/me',
  summary: 'Who is signed in, and what they can reach',
  responses: {
    200: sends(meBody, 'The person behind this session'),
    401: refusal('Nobody is signed in here'),
    404: refusal('The session names somebody who is no longer here'),
  },
})

const rename = createRoute({
  method: 'patch',
  path: '/me',
  summary: 'Change the name everything shows',
  request: { body: takes(newName) },
  responses: {
    204: saysNothing('Renamed'),
    400: refusal('The body was not the shape it claims'),
    401: refusal('Nobody is signed in here'),
  },
})

const makeSpace = createRoute({
  method: 'post',
  path: '/spaces',
  summary: 'Make a Space',
  request: { body: takes(newSpace) },
  responses: {
    201: sends(spaceBody, 'Made, with the requester as its first member'),
    200: sends(spaceBody, 'This request key already made one, and this is that one'),
    400: refusal('The name has no address in it, or the body was the wrong shape'),
    401: refusal('Nobody is signed in here'),
    409: sends(takenBody, 'Somebody holds that address; the suggestion is held for nobody'),
  },
})

const enterSpace = createRoute({
  method: 'get',
  path: '/spaces/{slug}',
  summary: 'Enter a Space',
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: sends(spaceBody, 'The Space at this address'),
    401: refusal('Nobody is signed in here'),
    404: refusal('Not there, or not yours — the same answer on purpose'),
  },
})

const leave = createRoute({
  method: 'delete',
  path: '/browser/sessions/current',
  summary: 'Stop being signed in',
  responses: {
    204: saysNothing('The session is revoked and the cookie is cleared'),
    401: refusal('Nobody is signed in here'),
  },
})

export type SpaceApi = {
  readonly db: Database
  /** The providers this deployment actually has keys for. */
  readonly providers: readonly Provider[]
}

/**
 * Each route names the session it needs instead of one `use('*')` covering them all. A wildcard
 * mounted at the root swallows every path in the whole app — including the sign-in routes, which
 * escaped only by being registered first. Nothing that important should rest on ordering.
 */
export function spaceApi({ db, providers }: SpaceApi) {
  const signedIn = requireSession(db)

  return api<{ Variables: Signed }>()
    .openapi({ ...whoAmI, middleware: [signedIn] }, async (c) => {
      const person = await personById(db, c.get('userId'))
      // The session names somebody the database no longer has. Nothing to be signed in as.
      if (person === undefined) return c.json(body(UNAVAILABLE), UNAVAILABLE.status)

      return c.json(
        {
          displayName: person.displayName,
          waysIn: waysIn(person.keys, providers),
          spaces: await spacesOf(db, person.id),
        },
        200,
      )
    })

    .openapi({ ...rename, middleware: [signedIn] }, async (c) => {
      await renamePerson(db, c.get('userId'), c.req.valid('json').displayName.trim())
      return c.body(null, 204)
    })

    .openapi({ ...makeSpace, middleware: [signedIn] }, async (c) => {
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

    .openapi({ ...enterSpace, middleware: [signedIn] }, async (c) => {
      const space = await spaceForMember(db, c.req.valid('param').slug, c.get('userId'))
      if (space === undefined) return c.json(body(UNAVAILABLE), UNAVAILABLE.status)
      return c.json(space, 200)
    })

    .openapi({ ...leave, middleware: [signedIn] }, async (c) => {
      const token = getCookie(c, SESSION_COOKIE)
      if (token !== undefined) await revokeSession(db, hashSessionToken(token))
      deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.body(null, 204)
    })
}
