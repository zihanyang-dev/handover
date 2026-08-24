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
import { api, saysNothing, sends, takes } from './contract.ts'
import { refusal } from './failure.ts'
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

const whoAmI = createRoute({
  method: 'get',
  path: '/me',
  summary: 'Who is signed in, and what they can reach',
  responses: {
    200: sends(meBody, 'The person behind this session'),
    401: refusal('Nobody is signed in here'),
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

const leave = createRoute({
  method: 'delete',
  path: '/browser/sessions/current',
  summary: 'Stop being signed in',
  responses: {
    204: saysNothing('The session is revoked and the cookie is cleared'),
    401: refusal('Nobody is signed in here'),
  },
})

export type MeApi = {
  readonly db: Database
  /** The providers this deployment actually has keys for. */
  readonly providers: readonly Provider[]
}

/**
 * Each route names the session it needs instead of one `use('*')` covering them all. A wildcard
 * mounted at the root swallows every path in the whole app — including the sign-in routes, which
 * escaped only by being registered first. Nothing that important should rest on ordering.
 */
export function meApi({ db, providers }: MeApi) {
  const signedIn = requireSession(db)

  return api<{ Variables: Signed }>()
    .openapi({ ...whoAmI, middleware: [signedIn] }, async (c) => {
      const person = await personById(db, c.get('userId'))

      return c.json(
        {
          displayName: person.displayName,
          credentials: shown(person.credentials, providers),
          spaces: await spacesOf(db, person.id),
        },
        200,
      )
    })

    .openapi({ ...rename, middleware: [signedIn] }, async (c) => {
      await renamePerson(db, c.get('userId'), c.req.valid('json').displayName.trim())
      return c.body(null, 204)
    })

    .openapi({ ...leave, middleware: [signedIn] }, async (c) => {
      const token = getCookie(c, SESSION_COOKIE)
      if (token !== undefined) await revokeSession(db, hashSessionToken(token))
      deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.body(null, 204)
    })
}
