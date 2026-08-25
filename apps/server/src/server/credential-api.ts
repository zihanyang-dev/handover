/**
 * Adding a way in to the account somebody is already signed in to.
 *
 * The provider half lives with the rest of the round trip in `oauth-api.ts`, because a handshake
 * is the same handshake whatever it is for. What is here is the half that proves an address: the
 * same two steps as signing in, and none of the same consequences.
 */

import { createRoute, z } from '@hono/zod-openapi'
import { addAddress } from '../db/credential.ts'
import type { Database } from '../db/connection.ts'
import { api, endpointsBehind, insteadOfMalformed, rowId, saysNothing, takes } from './contract.ts'
import { explainRejection, sendsACode, submittedCode, type SendCode } from './email-code.ts'
import { BEHIND_A_SESSION, body, refusal, type Failure } from './failure.ts'
import { requireSession, type Signed } from './session.ts'

export type CredentialApi = {
  readonly db: Database
  readonly secret: string
  readonly sendCode: SendCode
  /** What one caller may ask for in an hour, and how to tell callers apart. See `caller.ts`. */
  readonly lettersPerCallerPerHour: number
  readonly trustedProxyHops: number
}

/**
 * Said plainly. Whoever reads it has just proved they receive mail at that address, so they could
 * sign in to the account it opens with the next code they ask for — there is nothing left to
 * withhold, and withholding it would only leave them retrying something that cannot work.
 */
const ELSEWHERE: Failure<409> = { reason: 'address-elsewhere', recovery: 'retype', status: 409 }

/** Somebody already signed in, which is the whole difference from signing in. */
const behindASession = endpointsBehind<{ Variables: Signed }>()

export function credentialApi(deps: CredentialApi) {
  return api<{ Variables: Signed }>().openapiRoutes([asking(deps), answering(deps)])
}

/** Asking for a code at an address, which is the same route signing in asks with. */
function asking(deps: CredentialApi) {
  return sendsACode<'/me/credentials/email-codes', { Variables: Signed }>(deps, {
    path: '/me/credentials/email-codes',
    summary: 'Ask for a code at an address, to add it to this account',
    purpose: 'attach',
    middleware: [requireSession(deps.db)],
    alsoRefuses: BEHIND_A_SESSION,
  })
}

/** Answering it, which is the step that actually adds the address. */
function answering(deps: CredentialApi) {
  return behindASession({
    route: createRoute({
      method: 'post',
      path: '/me/credentials/email-codes/{id}/answer',
      summary: 'Answer the code, which adds the address to this account',
      middleware: [requireSession(deps.db)],
      request: { params: z.object({ id: rowId }), body: takes(submittedCode) },
      responses: {
        ...BEHIND_A_SESSION,
        204: saysNothing('The address now opens this account, or already did'),
        400: refusal('Wrong digits, or a body that was not the shape it claims'),
        404: refusal('There is no such code'),
        409: refusal('This code is finished, or the address opens a different account'),
        429: refusal('This code has no tries left'),
      },
    }),

    handler: async (c) => {
      const added = await addAddress(deps.db, {
        secret: deps.secret,
        user: c.get('userId'),
        answer: { codeId: c.req.valid('param').id, code: c.req.valid('json').code },
      })

      // Already this account's comes back attached: what was asked for is true either way.
      if (added.kind === 'attached') return c.body(null, 204)
      if (added.kind === 'rejected') return c.json(body(ELSEWHERE), ELSEWHERE.status)

      const refused = explainRejection(added.rejection)
      return c.json(body(refused), refused.status)
    },

    // An id that is not an id names no code, which is the situation a gone one is in, and gets
    // the answer that situation gets.
    hook: insteadOfMalformed(explainRejection('no-code')),
  })
}
