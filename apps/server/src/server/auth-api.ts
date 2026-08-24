/**
 * The way in for somebody who is not signed in: ask for a code, then hand it back.
 *
 * This layer owns no rule about what a code means. It parses what arrived, calls the transaction
 * that decides, and turns the decision into something a browser can act on.
 */

import { createRoute, z } from '@hono/zod-openapi'
import { api, sends, takes } from './contract.ts'
import type { Database } from '../db/connection.ts'
import { signInWithCode } from '../db/sign-in.ts'
import { newSessionToken } from '../identity/browser-session.ts'
import type { Provider } from '../identity/provider.ts'
import { offeredWays, WAY_KINDS } from '../identity/way-in.ts'
import {
  askForCode as ask,
  askedForCode,
  explainRejection,
  openedBody,
  submittedCode,
  waitBody,
  type SendCode,
} from './emailed-code.ts'
import { body, refusal } from './failure.ts'
import { startSession } from './session.ts'

export type { SendCode }

export type AuthApi = {
  readonly db: Database
  /** The providers this deployment has keys for. A way in nobody can use is not offered. */
  readonly providers: readonly Provider[]
  readonly secret: string
  readonly sendCode: SendCode
}

const signedInBody = z.object({ userId: z.uuid() }).openapi('SignedIn')

const offeredBody = z.object({ offered: z.array(z.enum(WAY_KINDS)).readonly() }).openapi('WaysIn')

const whatIsOffered = createRoute({
  method: 'get',
  path: '/auth/ways-in',
  summary: 'Which ways in this deployment can actually offer',
  responses: { 200: sends(offeredBody, 'Everything a stranger can use to get in') },
})

const askForCodeRoute = createRoute({
  method: 'post',
  path: '/auth/email-codes',
  summary: 'Ask for a code at an address',
  request: { body: takes(askedForCode) },
  responses: {
    201: sends(openedBody, 'A code is on its way, or was already sent for this request key'),
    400: refusal('The body was not the shape it claims, or no letter can reach that address'),
    429: sends(waitBody, 'A code went out moments ago; another would break the one in the inbox'),
  },
})

const answerCode = createRoute({
  method: 'post',
  path: '/auth/email-codes/{id}/answer',
  summary: 'Answer a code, which signs you in',
  request: { params: z.object({ id: z.string() }), body: takes(submittedCode) },
  responses: {
    200: sends(signedInBody, 'Signed in; the session is in a cookie the page cannot read'),
    400: refusal('Wrong digits, or a body that was not the shape it claims'),
    404: refusal('There is no such challenge'),
    409: refusal('This code is finished — used already, or replaced by a newer one'),
    429: refusal('This challenge has no tries left'),
  },
})

/** Every route states its contract, so the spec a client is built from comes from the routes. */
export function authApi(deps: AuthApi) {
  return (
    api()
      // Answered to a stranger on purpose: a sign-in page cannot offer a choice it cannot see.
      .openapi(whatIsOffered, (c) => c.json({ offered: offeredWays(deps.providers) }, 200))

      .openapi(askForCodeRoute, async (c) => {
        const answered = await ask(deps.db, deps.secret, deps.sendCode, {
          ...c.req.valid('json'),
          purpose: 'sign-in',
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

      .openapi(answerCode, async (c) => {
        const id = c.req.valid('param').id

        // An id that is not an id names no challenge, which is the situation a gone one is in,
        // and gets the answer that situation gets.
        if (!z.uuid().safeParse(id).success) {
          const failure = explainRejection('no-challenge')
          return c.json(body(failure), failure.status)
        }

        const session = newSessionToken()
        const result = await signInWithCode(deps.db, deps.secret, {
          challengeId: id,
          submittedCode: c.req.valid('json').code,
          sessionTokenHash: session.hash,
        })

        if (result.kind === 'rejected') {
          const failure = explainRejection(result.rejection)
          return c.json(body(failure), failure.status)
        }

        startSession(c, session.token)
        return c.json({ userId: result.userId }, 200)
      })
  )
}
