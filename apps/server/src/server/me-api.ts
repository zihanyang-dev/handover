/**
 * The signed-in person: who they are, what opens their account, and leaving.
 *
 * Every route here is behind a live session, so "who is asking" is never a parameter and never
 * something a caller can claim.
 */

import { z } from '@hono/zod-openapi'
import { deleteCookie, getCookie } from 'hono/cookie'
import type { Database } from '../db/connection.ts'
import { revokeSession } from '../db/session.ts'
import { spacesOf } from '../db/space.ts'
import { personById, renamePerson } from '../db/user.ts'
import { shown } from '../identity/credential.ts'
import { PROVIDERS, type Provider } from '../identity/provider.ts'
import { hashSessionToken } from '../identity/session.ts'
import { aPerson, named, nothing, sends } from './route.ts'
import { SESSION_COOKIE } from './session.ts'
import { Space } from './space-api.ts'

const Credential = z
  .union([
    z.object({ kind: z.literal('email'), address: z.email(), state: z.literal('ready') }),
    z.object({ kind: z.enum(PROVIDERS), state: z.enum(['ready', 'connectable']) }),
  ])
  .openapi('Credential')

const Me = named('Me', {
  displayName: z.string(),
  // No single address: there is no such thing any more. Every one this account holds is a row in
  // `credentials`, which is also the only place that says how many there are.
  credentials: z.array(Credential).readonly(),
  /**
   * Which way in this account was made with.
   *
   * Said rather than left to be worked out: the list above is ordered for reading — addresses,
   * then providers — so the order it arrives in no longer says which came first. `prd.md` 01 ③
   * owes somebody this word by name on the one occasion two ways in become one account.
   */
  startedWith: z.enum(['email', ...PROVIDERS]),
  spaces: z.array(Space).readonly(),
})

const NewDisplayName = named('NewDisplayName', { displayName: z.string().min(1).max(200) })

export type MeApi = {
  readonly db: Database
  /** The providers this deployment actually has keys for. */
  readonly providers: readonly Provider[]
}

export function meApi(deps: MeApi) {
  return [who(deps), renaming(deps), leaving(deps)]
}

/** Who is signed in, and everything they can reach from here. */
function who({ db, providers }: MeApi) {
  return aPerson(db).get('/me', {
    summary: 'Who is signed in, and what they can reach',
    answers: { 200: sends(Me, 'The person behind this session') },

    run: async (c) => {
      const person = await personById(db, c.get('userId'))

      return c.json(
        {
          displayName: person.displayName,
          credentials: shown(person.credentials, providers),
          // The oldest, which is what `credentialsOf` orders them by and what `shown` no longer
          // keeps. Absent is impossible: an account exists because a credential proved it.
          startedWith: person.credentials[0]?.kind ?? 'email',
          spaces: await spacesOf(db, person.id),
        },
        200,
      )
    },
  })
}

/** Changing the name everything shows. One name, so changing it changes every Space at once. */
function renaming({ db }: MeApi) {
  return aPerson(db).patch('/me', {
    summary: 'Change the name everything shows',
    body: NewDisplayName,
    answers: { 204: 'Renamed' },

    run: async (c) => {
      await renamePerson(db, c.get('userId'), c.req.valid('json').displayName.trim())

      return nothing(c, 204)
    },
  })
}

/** Leaving. The session is revoked on this side as well as forgotten on the browser's. */
function leaving({ db }: MeApi) {
  return aPerson(db).delete('/browser/sessions/current', {
    summary: 'Stop being signed in',
    answers: { 204: 'The session is revoked and the cookie is cleared' },

    run: async (c) => {
      const token = getCookie(c, SESSION_COOKIE)
      if (token !== undefined) await revokeSession(db, hashSessionToken(token))
      deleteCookie(c, SESSION_COOKIE, { path: '/' })

      return nothing(c, 204)
    },
  })
}
