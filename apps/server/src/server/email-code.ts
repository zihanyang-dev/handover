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
import { issueCode, noteDelivery } from '../db/email-code.ts'
import type { Database } from '../db/connection.ts'
import { DIGITS, hashCode, newCode, type Purpose, type Rejection } from '../identity/email-code.ts'
import { normalizeEmail } from '../identity/email-address.ts'
import { callerAddress, callerId } from './caller.ts'
import { endpointsBehind, sends, takes, type Shows } from './contract.ts'
import { failureBody, refusal, type Failure } from './failure.ts'

const askedForCode = z
  .object({
    // Folded here, at the edge, so nothing past this point has to remember to.
    email: z.email().transform(normalizeEmail).openapi({ example: 'mina@example.com' }),
    /** The caller's own key for this request. Retrying with it must not send a second mail. */
    requestKey: z.string().min(1).max(200),
  })
  .openapi('AskForCode')

/**
 * A code handed back, and which code it is.
 *
 * The id is in the body rather than the path, because the code is not the thing being made: what
 * comes into existence is a session on one route and a credential on the other, and the code is
 * only how somebody proves they may have it.
 */
export const submittedCode = z
  .object({
    /**
     * Which code.
     *
     * Not `uuid` here: one that is not an id names no code, which is the situation a gone one is
     * in, and it gets that situation's answer rather than "your browser sent something
     * malformed". Each route that takes this says so its own way — a hook, or a look.
     */
    codeId: z.string().max(64),
    code: z.string().min(1).max(20).openapi({ example: '493018' }),
  })
  .openapi('SubmitCode')

/**
 * Which code somebody means, or nothing when what arrived was not an id at all.
 *
 * Nothing, rather than a refusal: a string that is not an id names no code, which is exactly the
 * situation an expired one is in. Told "that sign-in is no longer here" a person starts again;
 * told their browser sent something malformed they have no idea what to do.
 */
export function whichCode(said: string): string | undefined {
  return z.uuid().safeParse(said).success ? said : undefined
}

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

const waitBody = failureBody
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
  /** Who asked, as a hash. Null when this deployment cannot honestly tell. */
  readonly askedBy: string | null
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
  /** This caller has asked for as many codes this hour as it may. Nothing is wrong with the
   *  address, and there is nothing to do but wait. */
  | {
      readonly kind: 'too-many'
      readonly body: z.infer<typeof waitBody>
      readonly retryAfterSeconds: number
    }
  | {
      readonly kind: 'too-soon'
      readonly body: z.infer<typeof waitBody>
      readonly retryAfterSeconds: number
    }
  | { readonly kind: 'undeliverable'; readonly body: z.infer<typeof failureBody> }

/** Nothing is wrong, and this is how long. The only two answers that carry a number. */
function waitFor(reason: string, retryAfterSeconds: number): Asked {
  return {
    kind: reason === 'too-soon' ? 'too-soon' : 'too-many',
    body: { reason, recovery: 'wait', retryAfterSeconds },
    retryAfterSeconds,
  }
}

/** No letter can reach that address, so there is nothing to wait for and something to fix. */
const UNDELIVERABLE = {
  kind: 'undeliverable',
  body: { reason: 'address-refused', recovery: 'retype' },
} as const

async function askForCode(sender: Sender, send: SendCode, request: CodeRequest): Promise<Asked> {
  const code = newCode()
  const opened = await issueCode(
    sender.db,
    {
      requestKey: request.requestKey,
      email: request.email,
      purpose: request.purpose,
      codeHash: hashCode(request.email, code, sender.secret),
      askedBy: request.askedBy,
    },
    sender.lettersPerCallerPerHour,
  )

  // Two different reasons to wait, and the same thing to do about either.
  if (opened.kind === 'too-soon') return waitFor('too-soon', opened.retryAfterSeconds)
  if (opened.kind === 'too-many') return waitFor('too-many-letters', opened.retryAfterSeconds)

  // This request already tried and no letter can reach that address. Told again rather than
  // dressed as success, which would leave somebody waiting for what will never arrive.
  if (opened.kind === 'undeliverable') return UNDELIVERABLE

  // A replay means the letter for this request is in that inbox, or may be. The code just minted
  // is not the one inside it, and a second code would kill the one somebody is reading.
  if (opened.kind === 'issued' && (await sending(sender, send, request, code)) === 'refused') {
    return UNDELIVERABLE
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
 * Hands the letter over and writes down what became of it.
 *
 * Written down before anybody is answered: the next request carrying this key has to be able to
 * tell "it went", "it never will" and "nobody knows" apart, and only this moment knows which of
 * the three it was.
 */
async function sending(
  sender: Sender,
  send: SendCode,
  request: CodeRequest,
  code: string,
): Promise<Awaited<ReturnType<SendCode>>> {
  const delivery = await send(request.email, code)
  await noteDelivery(sender.db, request, delivery)

  return delivery
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
  /** What one caller may ask for in an hour. */
  readonly lettersPerCallerPerHour: number
  /** How many proxies stand in front of this process, so a caller can be told apart honestly. */
  readonly trustedProxyHops: number
}

export function sendsACode<P extends string, E extends Env = BlankEnv>(
  deps: Sender,
  spec: {
    readonly path: P
    readonly summary: string
    readonly purpose: Purpose
    /** What has to run first. The one behind a session says so here, not at the mounting point. */
    readonly middleware?: MiddlewareHandler<E>[] | undefined
    /** Which door this one is mounted behind: one path is open, the other is behind a session. */
    readonly shows?: Shows | undefined
    /** What else this path can answer. Only the one behind a session can say nobody is signed in. */
    readonly alsoRefuses?: Readonly<Record<number, ReturnType<typeof refusal>>>
  },
) {
  return endpointsBehind<E>(spec.shows)({
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
      const answered = await askForCode(deps, deps.sendCode, {
        ...c.req.valid('json'),
        purpose: spec.purpose,
        askedBy: callerId(callerAddress(c, deps.trustedProxyHops)),
      })

      if (answered.kind === 'issued') return c.json(answered.body, 201)
      if (answered.kind === 'undeliverable') return c.json(answered.body, 400)

      // Both waits answer the same way: nothing is wrong, and this is how long.
      c.header('Retry-After', String(answered.retryAfterSeconds))
      return c.json(answered.body, 429)
    },
  })
}
