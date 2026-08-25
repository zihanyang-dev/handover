/**
 * The signed-in person: who they are, what opens their account, and leaving.
 *
 * Every route here is behind a live session, so "who is asking" is never a parameter and never
 * something a caller can claim.
 */

import { createRoute, z } from '@hono/zod-openapi'
import { deleteCookie, getCookie } from 'hono/cookie'
import { revokeSession } from '../db/session.ts'
import type { Database } from '../db/connection.ts'
import { spacesOf } from '../db/space.ts'
import { personById, renamePerson } from '../db/user.ts'
import { shown } from '../identity/credential.ts'
import { PROVIDERS, type Provider } from '../identity/provider.ts'
import { hashSessionToken } from '../identity/session.ts'
import { api, endpointsBehind, saysNothing, sends, takes } from './contract.ts'
import { BEHIND_A_SESSION, MALFORMED_BODY } from './failure.ts'
import { requireSession, SESSION_COOKIE, type Signed } from './session.ts'

const spaceBody = z
  .object({ id: z.uuid(), slug: z.string(), displayName: z.string() })
  .openapi('Space')

const credentialBody = z
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
  .openapi('Credential')

const meBody = z
  .object({
    displayName: z.string(),
    // No single address: there is no such thing any more. Every one this account holds is a row
    // in `credentials`, which is also the only place that says how many there are.
    credentials: z.array(credentialBody).readonly(),
    spaces: z.array(spaceBody).readonly(),
  })
  .openapi('Me')

const newName = z.object({ displayName: z.string().min(1).max(200) }).openapi('NewDisplayName')

export type MeApi = {
  readonly db: Database
  /** The providers this deployment actually has keys for. */
  readonly providers: readonly Provider[]
}

/**
 * Somebody signed in, which is the only door in this file.
 *
 * Said here rather than as one `use('*')` covering everything: a wildcard mounted at the root
 * swallows every path in the whole app — including the sign-in routes, which escaped only by
 * being registered first. Nothing this important should rest on ordering.
 */
const behindASession = endpointsBehind<{ Variables: Signed }>()

export function meApi(deps: MeApi) {
  return api<{ Variables: Signed }>().openapiRoutes([who(deps), renaming(deps), leaving(deps)])
}

/** Who is signed in, and everything they can reach from here. */
function who({ db, providers }: MeApi) {
  return behindASession({
    route: createRoute({
      method: 'get',
      path: '/me',
      summary: 'Who is signed in, and what they can reach',
      middleware: [requireSession(db)],
      responses: { ...BEHIND_A_SESSION, 200: sends(meBody, 'The person behind this session') },
    }),

    handler: async (c) => {
      const person = await personById(db, c.get('userId'))

      return c.json(
        {
          displayName: person.displayName,
          credentials: shown(person.credentials, providers),
          spaces: await spacesOf(db, person.id),
        },
        200,
      )
    },
  })
}

/** Changing the name everything shows. One name, so changing it changes every Space at once. */
function renaming({ db }: MeApi) {
  return behindASession({
    route: createRoute({
      method: 'patch',
      path: '/me',
      summary: 'Change the name everything shows',
      middleware: [requireSession(db)],
      request: { body: takes(newName) },
      responses: { ...BEHIND_A_SESSION, ...MALFORMED_BODY, 204: saysNothing('Renamed') },
    }),

    handler: async (c) => {
      await renamePerson(db, c.get('userId'), c.req.valid('json').displayName.trim())

      return c.body(null, 204)
    },
  })
}

/** Leaving. The session is revoked on this side as well as forgotten on the browser's. */
function leaving({ db }: MeApi) {
  return behindASession({
    route: createRoute({
      method: 'delete',
      path: '/browser/sessions/current',
      summary: 'Stop being signed in',
      middleware: [requireSession(db)],
      responses: {
        ...BEHIND_A_SESSION,
        204: saysNothing('The session is revoked and the cookie is cleared'),
      },
    }),

    handler: async (c) => {
      const token = getCookie(c, SESSION_COOKIE)
      if (token !== undefined) await revokeSession(db, hashSessionToken(token))
      deleteCookie(c, SESSION_COOKIE, { path: '/' })

      return c.body(null, 204)
    },
  })
}
