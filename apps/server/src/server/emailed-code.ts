/**
 * The transport half of the emailed code: what goes on the wire, and what a rejection is called
 * out here.
 *
 * Two screens send one — signing in, and attaching an address while already signed in — and they
 * need the same three things in the same order: commit the challenge, send, then decide what the
 * sending outcome means. Written twice, one of them would eventually learn something the other
 * did not.
 */

import { z } from '@hono/zod-openapi'
import { openChallenge } from '../db/email-challenge.ts'
import type { Database } from '../db/connection.ts'
import {
  DIGITS,
  hashCode,
  newCode,
  type Purpose,
  type Rejection,
} from '../identity/emailed-code.ts'
import { normalizeEmail } from '../identity/email-address.ts'
import { failureBody, type Failure } from './failure.ts'

export const askedForCode = z
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

export const openedBody = z
  .object({
    challengeId: z.uuid(),
    /** When the code stops working. Said here so a page shows what this deployment really does. */
    expiresAt: z.iso.datetime(),
    /** How long until another may be asked for. */
    resendAfterSeconds: z.number().int().min(0),
    /** How long the code is. A page that compiled in a six would submit five if this ever moved. */
    digits: z.number().int().positive(),
  })
  .openapi('OpenedChallenge')

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
    case 'no-challenge':
      return { reason: rejection, recovery: 'start-over', status: 404 }
  }
}

/**
 * Handing a code to somebody. Three answers, because "we do not know" is a real one — the mail
 * may be in flight.
 *
 * It returns its uncertainty instead of throwing it, because a failed send must not take down a
 * challenge that was committed and works.
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
 * they must never do is each decide what a challenge looks like on the wire, or what a refused
 * letter is called — so those are decided here, once.
 *
 * `undeliverable` is a refusal and `unknown` is not: the letter may already be in the inbox, and
 * telling somebody to retype an address that is about to receive a code turns their retry into a
 * second one.
 */
export type Asked =
  | { readonly kind: 'opened'; readonly body: z.infer<typeof openedBody> }
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
  const opened = await openChallenge(db, {
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
  if (opened.kind === 'opened' && (await send(request.email, code)) === 'refused') {
    return { kind: 'undeliverable', body: { reason: 'address-refused', recovery: 'retype' } }
  }

  return {
    kind: 'opened',
    body: {
      challengeId: opened.id,
      expiresAt: opened.expiresAt.toISOString(),
      resendAfterSeconds: opened.resendAfterSeconds,
      digits: DIGITS,
    },
  }
}
