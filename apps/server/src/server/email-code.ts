/**
 * The transport half of the emailed code: what goes on the wire, what a rejection is called out
 * here, and the route that sends one.
 *
 * Two screens send a code — signing in, and adding an address while already signed in — and they
 * differ in exactly two ways: the path, and what the proof is spent on. Everything else is the
 * same, so everything else is here, once. Written twice, one of them would eventually learn
 * something the other did not.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { BlankEnv } from 'hono/types'
import type { Env, MiddlewareHandler } from 'hono'
import { issueCode } from '../db/email-code.ts'
import type { Database } from '../db/connection.ts'
import { DIGITS, hashCode, newCode, type Purpose, type Rejection } from '../identity/email-code.ts'
import { normalizeEmail } from '../identity/email-address.ts'
import { endpointsBehind, sends, takes } from './contract.ts'
import { failureBody, refusal, type Failure } from './failure.ts'

const askedForCode = z
  .object({
    // Folded here, at the edge, so nothing past this point has to remember to.
    email: z.email().transform(normalizeEmail).openapi({ example: 'mina@example.com' }),
    /** The caller's own key for this request. Retrying with it must not send a second mail. */
    requestKey: z.string().min(1).max(200),
  })
  .openapi('AskForCode')

export const submittedCode = z
  .object({ code: z.string().min(1).max(20).openapi({ example: '493018' }) })
  .openapi('SubmitCode')

const issuedBody = z
  .object({
    codeId: z.uuid(),
    /** When the code stops working. Said here so a page shows what this deployment really does. */
    expiresAt: z.iso.datetime(),
    /** How long until another may be asked for. */
    resendAfterSeconds: z.number().int().min(0),
    /** How long the code is. A page that compiled in a six would submit five if this ever moved. */
    digits: z.number().int().positive(),
  })
  .openapi('IssuedCode')

export const waitBody = failureBody
  .extend({ retryAfterSeconds: z.number().int().positive() })
  .openapi('TooSoon')

/**
 * The `identity` owner's vocabulary is not public vocabulary, and translating it is transport's
 * job. It sits here rather than in either route because both screens hand a code back, and two
 * translations of one vocabulary is how the two screens start disagreeing about what happened.
 *
 * `consumed` and `expired` share a recovery but stay separate reasons: being told a code was
 * already used is being told somebody may have used it, and that is worth knowing even though
 * the next click is the same.
 */
export type CodeRefusal = Failure<400 | 404 | 409 | 429>

export function explainRejection(rejection: Rejection): CodeRefusal {
  switch (rejection) {
    case 'code-mismatch':
      return { reason: rejection, recovery: 'retype', status: 400 }
    case 'expired':
      return { reason: rejection, recovery: 'request-new-code', status: 409 }
    case 'consumed':
      return { reason: rejection, recovery: 'request-new-code', status: 409 }
    case 'attempts-exhausted':
      return { reason: rejection, recovery: 'start-over', status: 429 }
    case 'no-code':
      return { reason: rejection, recovery: 'start-over', status: 404 }
  }
}

/**
 * Handing a code to somebody. Three answers, because "we do not know" is a real one — the mail
 * may be in flight.
 *
 * It returns its uncertainty instead of throwing it, because a failed send must not take down a
 * code that was committed and works.
 */
export type SendCode = (to: string, code: string) => Promise<'sent' | 'refused' | 'unknown'>

export type CodeRequest = {
  readonly requestKey: string
  readonly email: string
  readonly purpose: Purpose
}

/**
 * What came of asking, already in the shape it goes out in.
 *
 * Two screens ask, and each one renders this in four lines that read as its own contract. What
 * they must never do is each decide what a live code looks like on the wire, or what a refused
 * letter is called — so those are decided here, once.
 *
 * `undeliverable` is a refusal and `unknown` is not: the letter may already be in the inbox, and
 * telling somebody to retype an address that is about to receive a code turns their retry into a
 * second one.
 */
export type Asked =
  | { readonly kind: 'issued'; readonly body: z.infer<typeof issuedBody> }
  | {
      readonly kind: 'too-soon'
      readonly body: z.infer<typeof waitBody>
      readonly retryAfterSeconds: number
    }
  | { readonly kind: 'undeliverable'; readonly body: z.infer<typeof failureBody> }

export async function askForCode(
  db: Database,
  secret: string,
  send: SendCode,
  request: CodeRequest,
): Promise<Asked> {
  const code = newCode()
  const opened = await issueCode(db, {
    requestKey: request.requestKey,
    email: request.email,
    purpose: request.purpose,
    codeHash: hashCode(request.email, code, secret),
  })

  if (opened.kind === 'too-soon') {
    return {
      kind: 'too-soon',
      body: {
        reason: 'too-soon',
        recovery: 'wait',
        retryAfterSeconds: opened.retryAfterSeconds,
      },
      retryAfterSeconds: opened.retryAfterSeconds,
    }
  }

  // A replay means the mail for this request is already sent or already in flight, and the code
  // just minted is not the one inside it. Sending would put two codes in one inbox.
  if (opened.kind === 'issued' && (await send(request.email, code)) === 'refused') {
    return { kind: 'undeliverable', body: { reason: 'address-refused', recovery: 'retype' } }
  }

  return {
    kind: 'issued',
    body: {
      codeId: opened.id,
      expiresAt: opened.expiresAt.toISOString(),
      resendAfterSeconds: opened.resendAfterSeconds,
      digits: DIGITS,
    },
  }
}

/**
 * The route that sends a code, in the same shape as any other endpoint, so both screens mount it
 * the way they mount their own and cannot end up disagreeing about what a wait, a dead address,
 * or a live code looks like on the wire.
 *
 * The literal path flows through the generic, so each caller still gets its own path typed into
 * the generated contract.
 */
export type Sender = {
  readonly db: Database
  readonly secret: string
  readonly sendCode: SendCode
}

export function sendsACode<P extends string, E extends Env = BlankEnv>(
  deps: Sender,
  spec: {
    readonly path: P
    readonly summary: string
    readonly purpose: Purpose
    /** What has to run first. The one behind a session says so here, not at the mounting point. */
    readonly middleware?: MiddlewareHandler<E>[] | undefined
    /** What else this path can answer. Only the one behind a session can say nobody is signed in. */
    readonly alsoRefuses?: Readonly<Record<number, ReturnType<typeof refusal>>>
  },
) {
  return endpointsBehind<E>()({
    route: createRoute({
      method: 'post',
      path: spec.path,
      summary: spec.summary,
      ...(spec.middleware === undefined ? {} : { middleware: spec.middleware }),
      request: { body: takes(askedForCode) },
      responses: {
        201: sends(issuedBody, 'A code is on its way, or was already sent for this request key'),
        400: refusal('The body was not the shape it claims, or no letter can reach that address'),
        429: sends(
          waitBody,
          'A code went out moments ago; another would break the one in the inbox',
        ),
        ...spec.alsoRefuses,
      },
    }),

    handler: async (c) => {
      const answered = await askForCode(deps.db, deps.secret, deps.sendCode, {
        ...c.req.valid('json'),
        purpose: spec.purpose,
      })

      if (answered.kind === 'issued') return c.json(answered.body, 201)
      if (answered.kind === 'undeliverable') return c.json(answered.body, 400)

      c.header('Retry-After', String(answered.retryAfterSeconds))
      return c.json(answered.body, 429)
    },
  })
}
