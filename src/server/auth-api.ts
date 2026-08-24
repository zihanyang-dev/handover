/**
 * The way in: ask for a code, then hand it back.
 *
 * This layer owns no rule about what a code means. It parses what arrived, calls the transaction
 * that decides, and turns the decision into something a browser can act on.
 */

import { createRoute, z } from '@hono/zod-openapi'
import { setCookie } from 'hono/cookie'
import { api, sends, takes } from './contract.ts'
import type { Database } from '../db/connection.ts'
import { openChallenge } from '../db/email-challenge.ts'
import { signIn } from '../db/sign-in.ts'
import { LIFETIME_DAYS, newSessionToken } from '../identity/browser-session.ts'
import { hashCode, newCode, type Rejection } from '../identity/emailed-code.ts'
import { PROVIDERS, type Provider } from '../identity/provider.ts'
import { waysIn } from '../identity/ways-in.ts'
import { normalizeEmail } from '../identity/verified-email.ts'
import { body, failureBody, refusal, type Failure } from './failure.ts'
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
  /** The providers this deployment has keys for. A way in nobody can use is not offered. */
  readonly providers: readonly Provider[]
  readonly secret: string
  readonly sendCode: SendCode
}

const askedForCode = z
  .object({
    // Folded here, at the edge, so nothing past this point has to remember to.
    email: z.email().transform(normalizeEmail).openapi({ example: 'mina@example.com' }),
    /** The caller's own key for this request. Retrying with it must not send a second mail. */
    requestKey: z.string().min(1).max(200),
  })
  .openapi('AskForCode')

const submittedCode = z
  .object({ code: z.string().min(1).max(20).openapi({ example: '493018' }) })
  .openapi('SubmitCode')

const openedBody = z
  .object({
    challengeId: z.uuid(),
    /** When the code stops working. Said here so a page shows what this deployment really does. */
    expiresAt: z.iso.datetime(),
    /** How long until another may be asked for. */
    resendAfterSeconds: z.number().int().min(0),
  })
  .openapi('OpenedChallenge')

const waitBody = failureBody
  .extend({ retryAfterSeconds: z.number().int().positive() })
  .openapi('TooSoon')

const signedInBody = z.object({ userId: z.uuid() }).openapi('SignedIn')

/** Every way in there is, named once. A screen offering one that does not exist is a dead door. */
const WAYS = ['email-code', ...PROVIDERS] as const

const offeredBody = z.object({ offered: z.array(z.enum(WAYS)).readonly() }).openapi('WaysIn')

const whatIsOffered = createRoute({
  method: 'get',
  path: '/auth/ways-in',
  summary: 'Which ways in this deployment can actually offer',
  responses: { 200: sends(offeredBody, 'Everything a stranger can use to get in') },
})

const askForCode = createRoute({
  method: 'post',
  path: '/auth/email/challenges',
  summary: 'Ask for a code at an address',
  request: { body: takes(askedForCode) },
  responses: {
    201: sends(openedBody, 'A code is on its way, or was already sent for this request key'),
    400: refusal('The body was not the shape it claims'),
    429: sends(waitBody, 'A code went out moments ago; another would break the one in the inbox'),
  },
})

const handBackCode = createRoute({
  method: 'post',
  path: '/auth/email/challenges/{id}/verify',
  summary: 'Hand a code back',
  request: { params: z.object({ id: z.string() }), body: takes(submittedCode) },
  responses: {
    200: sends(signedInBody, 'Signed in; the session is in a cookie the page cannot read'),
    400: refusal('Wrong digits, or a body that was not the shape it claims'),
    404: refusal('There is no such challenge'),
    409: refusal('This code is finished — used already, or replaced by a newer one'),
    429: refusal('This challenge has no tries left'),
  },
})

/**
 * The `identity` owner's vocabulary is not public vocabulary, and translating it is transport's
 * job, so the mapping sits with the route that answers.
 *
 * `consumed` and `expired` share a recovery but stay separate reasons: being told a code was
 * already used is being told somebody may have signed in with it, and that is worth knowing even
 * though the next click is the same.
 */
type SignInRefusal = Failure<400 | 404 | 409 | 429>

function explainRejection(rejection: Rejection): SignInRefusal {
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
  | {
      readonly kind: 'opened'
      readonly challengeId: string
      readonly expiresAt: string
      readonly resendAfterSeconds: number
    }
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

  return {
    kind: 'opened',
    challengeId: opened.id,
    expiresAt: opened.expiresAt.toISOString(),
    resendAfterSeconds: opened.resendAfterSeconds,
  }
}

type Verified =
  | { readonly kind: 'signed-in'; readonly userId: string; readonly token: string }
  | { readonly kind: 'rejected'; readonly failure: SignInRefusal }

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

/** Every route states its contract, so the spec a client is built from comes from the routes. */
export function authApi(deps: AuthApi) {
  return (
    api()
      // Answered to a stranger on purpose: a sign-in page cannot offer a choice it cannot see.
      .openapi(whatIsOffered, (c) =>
        c.json({ offered: waysIn([], deps.providers).map((way) => way.kind) }, 200),
      )

      .openapi(askForCode, async (c) => {
        const outcome = await open(deps, c.req.valid('json'))

        if (outcome.kind === 'too-soon') {
          c.header('Retry-After', String(outcome.retryAfterSeconds))
          return c.json(
            {
              reason: 'too-soon',
              recovery: 'wait' as const,
              retryAfterSeconds: outcome.retryAfterSeconds,
            },
            429,
          )
        }
        const { challengeId, expiresAt, resendAfterSeconds } = outcome
        return c.json({ challengeId, expiresAt, resendAfterSeconds }, 201)
      })

      .openapi(handBackCode, async (c) => {
        const outcome = await verify(deps, c.req.valid('param').id, c.req.valid('json').code)

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
        return c.json({ userId: outcome.userId }, 200)
      })
  )
}
