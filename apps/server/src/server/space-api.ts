/**
 * Spaces: making one, and entering one.
 *
 * Both are behind a live session, so "who is asking" is never a parameter and never something a
 * caller can claim.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { Database } from '../db/connection.ts'
import { createSpace, spaceForMember } from '../db/space.ts'
import { normalizeSlug } from '@handover/universal'
import { api, sends, takes } from './contract.ts'
import { body, refusal, type Failure } from './failure.ts'
import { requireSession, type Signed } from './session.ts'

/** A Space that is not there and a Space you are not in are the same answer, on purpose. */
const UNAVAILABLE: Failure<404> = { reason: 'unavailable', recovery: 'start-over', status: 404 }

/** A name of pure punctuation has no address, and no address means no Space. */
const UNUSABLE_NAME: Failure<400> = {
  reason: 'unusable-name',
  recovery: 'choose-another-name',
  status: 400,
}

const spaceBody = z
  .object({ id: z.uuid(), slug: z.string(), displayName: z.string() })
  .openapi('Space')

const newSpace = z
  .object({
    displayName: z.string().min(1).max(200).openapi({ example: '徐悦泰 Studio' }),
    requestKey: z.string().min(1).max(200),
  })
  .openapi('NewSpace')

const takenBody = z
  .object({
    reason: z.literal('slug-taken'),
    recovery: z.literal('choose-another-name'),
    suggestion: z.string().openapi({ example: 'acme-2' }),
  })
  .openapi('SlugTaken')

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

export function spaceApi(db: Database) {
  const signedIn = requireSession(db)

  return api<{ Variables: Signed }>()
    .openapi({ ...makeSpace, middleware: [signedIn] }, async (c) => {
      const asked = c.req.valid('json')
      const slug = normalizeSlug(asked.displayName)
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
}
