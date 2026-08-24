/**
 * Adding a way in to the account somebody is already signed in to.
 *
 * The provider half lives with the rest of the round trip in `oauth-api.ts`, because a handshake
 * is the same handshake whatever it is for. What is here is the half that proves an address: the
 * same two steps as signing in, and none of the same consequences.
 */

import { createRoute, z } from '@hono/zod-openapi'
import { addAddress } from '../db/connect.ts'
import type { Database } from '../db/connection.ts'
import { api, saysNothing, sends, takes } from './contract.ts'
import {
  askForCode as ask,
  askedForCode,
  explainRejection,
  openedBody,
  submittedCode,
  waitBody,
  type SendCode,
} from './emailed-code.ts'
import { body, refusal, type Failure } from './failure.ts'
import { requireSession, type Signed } from './session.ts'

export type WaysInApi = {
  readonly db: Database
  readonly secret: string
  readonly sendCode: SendCode
}

/**
 * Said plainly. Whoever reads it has just proved they receive mail at that address, so they could
 * sign in to the account it opens with the next code they ask for — there is nothing left to
 * withhold, and withholding it would only leave them retrying something that cannot work.
 */
const ELSEWHERE: Failure<409> = { reason: 'address-elsewhere', recovery: 'retype', status: 409 }

const askForAddress = createRoute({
  method: 'post',
  path: '/me/ways-in/email-codes',
  summary: 'Ask for a code at an address, to add it to this account',
  request: { body: takes(askedForCode) },
  responses: {
    201: sends(openedBody, 'A code is on its way, or was already sent for this request key'),
    400: refusal('The body was not the shape it claims, or no letter can reach that address'),
    401: refusal('Nobody is signed in here'),
    429: sends(waitBody, 'A code went out moments ago; another would break the one in the inbox'),
  },
})

const answerCode = createRoute({
  method: 'post',
  path: '/me/ways-in/email-codes/{id}/answer',
  summary: 'Answer the code, which adds the address to this account',
  request: { params: z.object({ id: z.string() }), body: takes(submittedCode) },
  responses: {
    204: saysNothing('The address now opens this account, or already did'),
    400: refusal('Wrong digits, or a body that was not the shape it claims'),
    401: refusal('Nobody is signed in here'),
    404: refusal('There is no such code'),
    409: refusal('This code is finished, or the address opens a different account'),
    429: refusal('This code has no tries left'),
  },
})

export function waysInApi(deps: WaysInApi) {
  const signedIn = requireSession(deps.db)

  return api<{ Variables: Signed }>()
    .openapi({ ...askForAddress, middleware: [signedIn] }, async (c) => {
      const answered = await ask(deps.db, deps.secret, deps.sendCode, {
        ...c.req.valid('json'),
        purpose: 'attach',
      })

      switch (answered.kind) {
        case 'opened':
          return c.json(answered.body, 201)
        case 'undeliverable':
          return c.json(answered.body, 400)
        case 'too-soon':
          c.header('Retry-After', String(answered.retryAfterSeconds))
          return c.json(answered.body, 429)
      }
    })

    .openapi({ ...answerCode, middleware: [signedIn] }, async (c) => {
      const id = c.req.valid('param').id

      // An id that is not an id names no code, which is the situation a gone one is in, and gets
      // the answer that situation gets.
      const failure = z.uuid().safeParse(id).success ? undefined : explainRejection('no-challenge')
      if (failure !== undefined) return c.json(body(failure), failure.status)

      const added = await addAddress(deps.db, deps.secret, c.get('userId'), {
        challengeId: id,
        code: c.req.valid('json').code,
      })

      // Already this account's comes back attached: what was asked for is true either way.
      if (added.kind === 'attached') return c.body(null, 204)
      if (added.kind === 'rejected') return c.json(body(ELSEWHERE), ELSEWHERE.status)

      const refused = explainRejection(added.rejection)
      return c.json(body(refused), refused.status)
    })
}
