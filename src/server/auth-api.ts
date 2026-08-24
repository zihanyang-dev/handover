/**
 * The way in: ask for a code, then hand it back.
 *
 * This layer owns no rule about what a code means. It parses what arrived, calls the transaction
 * that decides, and turns the decision into something a browser can act on.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { Database } from '../db/connection.ts'
import { openChallenge } from '../db/email-challenge.ts'
import { signIn } from '../db/sign-in.ts'
import { LIFETIME_DAYS, newSessionToken } from '../identity/browser-session.ts'
import { hashCode, newCode, type Rejection } from '../identity/emailed-code.ts'
import { normalizeEmail } from '../identity/verified-email.ts'
import { body, MALFORMED, refuse, type Failure } from './failure.ts'
import { SESSION_COOKIE } from './session.ts'

/**
 * Handing a code to somebody. Three answers, because "we do not know" is a real one — the mail
 * may be in flight. Whichever it is, this route answers the same way: the challenge is valid and
 * the person can ask for another code. Recording the outcome belongs to whoever sends the mail.
 *
 * It returns its uncertainty instead of throwing it, because a failed send must not take down a
 * challenge that was committed and works.
 */
export type SendCode = (to: string, code: string) => Promise<'sent' | 'refused' | 'unknown'>

export type AuthApi = {
  readonly db: Database
  readonly secret: string
  readonly sendCode: SendCode
}

const malformed = (result: { success: boolean }): void => {
  if (!result.success) refuse(MALFORMED)
}

const askedForCode = z.object({
  // Folded here, at the edge, so nothing past this point has to remember to.
  email: z.email().transform(normalizeEmail),
  /** The caller's own key for this request. Retrying with it must not send a second mail. */
  requestKey: z.string().min(1).max(200),
})

const submittedCode = z.object({ code: z.string().min(1).max(20) })

/**
 * The `identity` owner's vocabulary is not public vocabulary, and translating it is transport's
 * job, so the mapping sits with the route that answers.
 *
 * `consumed` and `expired` share a recovery but stay separate reasons: being told a code was
 * already used is being told somebody may have signed in with it, and that is worth knowing even
 * though the next click is the same.
 */
function explainRejection(rejection: Rejection): Failure {
  switch (rejection) {
    case 'code-mismatch':
      return { reason: rejection, recovery: 'retype', status: 400 }
    case 'expired':
      return { reason: rejection, recovery: 'request-new-code', status: 409 }
    case 'consumed':
      return { reason: rejection, recovery: 'request-new-code', status: 409 }
    case 'attempts-exhausted':
      return { reason: rejection, recovery: 'start-over', status: 429 }
    case 'no-challenge':
      return { reason: rejection, recovery: 'start-over', status: 404 }
  }
}

type Opened =
  | { readonly kind: 'opened'; readonly challengeId: string }
  | { readonly kind: 'too-soon'; readonly retryAfterSeconds: number }

async function open(deps: AuthApi, asked: z.infer<typeof askedForCode>): Promise<Opened> {
  const code = newCode()
  const opened = await openChallenge(deps.db, {
    requestKey: asked.requestKey,
    email: asked.email,
    codeHash: hashCode(asked.email, code, deps.secret),
  })

  if (opened.kind === 'too-soon') return opened
  // A replay means the mail for this request is already sent or already in flight, and the code
  // just minted is not the one inside it. Sending would put two codes in one inbox.
  if (opened.kind === 'opened') await deps.sendCode(asked.email, code)
  return { kind: 'opened', challengeId: opened.id }
}

type Verified =
  | { readonly kind: 'signed-in'; readonly userId: string; readonly token: string }
  | { readonly kind: 'rejected'; readonly failure: Failure }

async function verify(deps: AuthApi, challengeId: string, code: string): Promise<Verified> {
  // An id that is not an id names no challenge, which is the situation a gone one is in, and
  // gets the answer that situation gets.
  if (!z.uuid().safeParse(challengeId).success) {
    return { kind: 'rejected', failure: explainRejection('no-challenge') }
  }

  const session = newSessionToken()
  const result = await signIn(deps.db, deps.secret, {
    challengeId,
    submittedCode: code,
    sessionTokenHash: session.hash,
  })

  return result.kind === 'signed-in'
    ? { kind: 'signed-in', userId: result.userId, token: session.token }
    : { kind: 'rejected', failure: explainRejection(result.rejection) }
}

/** Chained, not statement by statement: that is what carries the route types to an RPC client. */
export function authApi(deps: AuthApi) {
  return new Hono()
    .post('/auth/email/challenges', zValidator('json', askedForCode, malformed), async (c) => {
      const outcome = await open(deps, c.req.valid('json'))

      if (outcome.kind === 'too-soon') {
        c.header('Retry-After', String(outcome.retryAfterSeconds))
        return c.json(
          { reason: 'too-soon', recovery: 'wait', retryAfterSeconds: outcome.retryAfterSeconds },
          429,
        )
      }
      return c.json({ challengeId: outcome.challengeId }, 201)
    })

    .post(
      '/auth/email/challenges/:id/verify',
      zValidator('json', submittedCode, malformed),
      async (c) => {
        const outcome = await verify(deps, c.req.param('id'), c.req.valid('json').code)

        if (outcome.kind === 'rejected') {
          return c.json(body(outcome.failure), outcome.failure.status)
        }

        setCookie(c, SESSION_COOKIE, outcome.token, {
          httpOnly: true,
          sameSite: 'Lax',
          path: '/',
          secure: new URL(c.req.url).protocol === 'https:',
          maxAge: LIFETIME_DAYS * 24 * 60 * 60,
        })
        return c.json({ userId: outcome.userId })
      },
    )
}
