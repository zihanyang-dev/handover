/**
 * Spaces: making one, and entering one.
 *
 * Both are behind a live session, so "who is asking" is never a parameter and never something a
 * caller can claim.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { Database } from '../db/connection.ts'
import { createSpace } from '../db/space.ts'
import { normalizeSlug } from '@handover/universal'
import { api, endpointsBehind, sends, takes } from './contract.ts'
import { BEHIND_A_SESSION, body, refusal, type Failure } from './failure.ts'
import { requireMember, type InSpace } from './membership.ts'
import { requireSession, type Signed } from './session.ts'

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

/**
 * Somebody signed in, and somebody signed in who is a member of the Space in the path.
 *
 * Two doors, said once each, because which one an endpoint is behind is the one thing that decides
 * what `c` holds. Making one is behind the weaker of the two: there is no Space to be a member of
 * yet, which is the whole of what the endpoint is for.
 */
const signedIn = endpointsBehind<{ Variables: Signed }>()
const theirs = endpointsBehind<{ Variables: Signed & InSpace }>()

export function spaceApi(db: Database) {
  return api<{ Variables: Signed }>()
    .openapiRoutes([making(db)])
    .route('/', api<{ Variables: Signed & InSpace }>().openapiRoutes([entering(db)]))
}

/** Making one, with whoever asked as its first member. */
function making(db: Database) {
  return signedIn({
    route: createRoute({
      method: 'post',
      path: '/spaces',
      summary: 'Make a Space',
      middleware: [requireSession(db)],
      request: { body: takes(newSpace) },
      responses: {
        ...BEHIND_A_SESSION,
        201: sends(spaceBody, 'Made, with the requester as its first member'),
        200: sends(spaceBody, 'This request key already made one, and this is that one'),
        400: refusal('The name has no address in it, or the body was the wrong shape'),
        409: sends(takenBody, 'Somebody holds that address; the suggestion is held for nobody'),
      },
    }),

    handler: async (c) => {
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
    },
  })
}

/** Entering one. The gate answers it entirely: reaching the handler is the whole question. */
function entering(db: Database) {
  return theirs({
    route: createRoute({
      method: 'get',
      path: '/spaces/{slug}',
      summary: 'Enter a Space',
      middleware: [requireSession(db), requireMember(db)],
      request: { params: z.object({ slug: z.string() }) },
      responses: {
        ...BEHIND_A_SESSION,
        200: sends(spaceBody, 'The Space at this address'),
        404: refusal('Not there, or not yours — the same answer on purpose'),
      },
    }),

    handler: (c) => c.json(c.get('space'), 200),
  })
}
