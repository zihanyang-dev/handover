/**
 * The way in for somebody who is not signed in: ask for a code, then hand it back.
 *
 * This layer owns no rule about what a code means. It parses what arrived, calls the transaction
 * that decides, and turns the decision into something a browser can act on.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { Env } from 'hono'
import { api, endpointsBehind, sends, takes } from './contract.ts'
import type { Database } from '../db/connection.ts'
import { signInWithCode } from '../db/sign-in.ts'
import { newSessionToken } from '../identity/session.ts'
import type { Provider } from '../identity/provider.ts'
import { offeredKinds, CREDENTIAL_KINDS } from '../identity/credential.ts'
import { explainRejection, sendsACode, submittedCode, type SendCode } from './email-code.ts'
import { body, refusal } from './failure.ts'
import { startSession } from './session.ts'

export type { SendCode }

export type SignInApi = {
  readonly db: Database
  /**
   * Where a browser reaches this app. It decides whether the session cookie is marked `Secure` —
   * read from the request, TLS that ends at a proxy would look like plain HTTP and it never would
   * be.
   */
  readonly webOrigin: string
  /** The providers this deployment has keys for. A way in nobody can use is not offered. */
  readonly providers: readonly Provider[]
  readonly secret: string
  readonly sendCode: SendCode
}

const signedInBody = z.object({ userId: z.uuid() }).openapi('SignedIn')

const offeredBody = z
  .object({ offered: z.array(z.enum(CREDENTIAL_KINDS)).readonly() })
  .openapi('OfferedCredentials')

/**
 * Nobody, which is the point: everything here is reachable by somebody with no way in yet.
 *
 * There is still a door — it is just an open one, and naming it says that on purpose rather than
 * by the absence of anything.
 */
const openToAnyone = endpointsBehind<Env>()

export function signInApi(deps: SignInApi) {
  return api().openapiRoutes([offering(deps), asking(deps), answering(deps)])
}

/** Asking for a code at an address, which is the same route adding one asks with. */
function asking(deps: SignInApi) {
  return sendsACode(deps, {
    path: '/auth/email-codes',
    summary: 'Ask for a code at an address',
    purpose: 'sign-in',
  })
}

/** Which ways in this deployment can actually offer. A way nobody can use is not offered. */
function offering(deps: SignInApi) {
  return openToAnyone({
    route: createRoute({
      method: 'get',
      path: '/auth/credentials',
      summary: 'Which ways in this deployment can actually offer',
      // Answered to a stranger on purpose: a sign-in page cannot offer a choice it cannot see.
      responses: { 200: sends(offeredBody, 'Everything a stranger can use to get in') },
    }),

    handler: (c) => c.json({ offered: offeredKinds(deps.providers) }, 200),
  })
}

/** Handing a code back, which is the step that signs somebody in. */
function answering(deps: SignInApi) {
  return openToAnyone({
    route: createRoute({
      method: 'post',
      path: '/auth/email-codes/{id}/answer',
      summary: 'Answer a code, which signs you in',
      request: { params: z.object({ id: z.string() }), body: takes(submittedCode) },
      responses: {
        200: sends(signedInBody, 'Signed in; the session is in a cookie the page cannot read'),
        400: refusal('Wrong digits, or a body that was not the shape it claims'),
        404: refusal('There is no such code'),
        409: refusal('This code is finished — used already, or replaced by a newer one'),
        429: refusal('This code has no tries left'),
      },
    }),

    handler: async (c) => {
      const id = c.req.valid('param').id

      // An id that is not an id names no code, which is the situation a gone one is in, and gets
      // the answer that situation gets.
      if (!z.uuid().safeParse(id).success) {
        const failure = explainRejection('no-code')
        return c.json(body(failure), failure.status)
      }

      const session = newSessionToken()
      const result = await signInWithCode(deps.db, deps.secret, {
        codeId: id,
        submittedCode: c.req.valid('json').code,
        sessionTokenHash: session.hash,
      })

      if (result.kind === 'rejected') {
        const failure = explainRejection(result.rejection)
        return c.json(body(failure), failure.status)
      }

      startSession(c, session.token, deps.webOrigin)

      return c.json({ userId: result.userId }, 200)
    },
  })
}
