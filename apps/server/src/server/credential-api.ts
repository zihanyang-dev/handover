/**
 * Proving who somebody is: what ways in this deployment offers, the emailed code that proves an
 * address, and what a proved address buys — a session for a stranger, one more way in for
 * somebody already here.
 *
 * One module because it is one mechanism used twice. The two halves differ in exactly two things:
 * the door they are behind, and what the proof is spent on. Written as two, one of them would
 * eventually learn something the other did not.
 *
 * The provider round trip is the other way in, and it is its own file: it is the only thing here
 * that talks to somebody else's server.
 */

import { createHash } from 'node:crypto'
import { getConnInfo } from '@hono/node-server/conninfo'
import { z } from '@hono/zod-openapi'
import type { Context, Env } from 'hono'
import type { Database } from '../db/connection.ts'
import { addAddress } from '../db/credential.ts'
import { issueCode, noteDelivery } from '../db/email-code.ts'
import { signInWithCode } from '../db/sign-in.ts'
import { CREDENTIAL_KINDS, offeredKinds } from '../identity/credential.ts'
import { normalizeEmail } from '../identity/email-address.ts'
import { DIGITS, hashCode, newCode, type Purpose, type Rejection } from '../identity/email-code.ts'
import type { Provider } from '../identity/provider.ts'
import { newSessionToken } from '../identity/session.ts'
import { failureBody, refused, type Failure } from './failure.ts'
import { aPerson, anyone, named, nothing, refusal, sends } from './route.ts'
import { startSession } from './session.ts'

export type CredentialApi = {
  readonly db: Database
  readonly secret: string
  readonly sendCode: SendCode
  /** What one caller may ask for in an hour. */
  readonly lettersPerCallerPerHour: number
  /** How many proxies stand in front of this process, so a caller can be told apart honestly. */
  readonly trustedProxyHops: number
  /**
   * Where a browser reaches this app. It decides whether the session cookie is marked `Secure` —
   * read from the request, TLS that ends at a proxy would look like plain HTTP and it never would
   * be.
   */
  readonly webOrigin: string
  /** The providers this deployment has keys for. A way in nobody can use is not offered. */
  readonly providers: readonly Provider[]
}

/**
 * Said plainly. Whoever reads it has just proved they receive mail at that address, so they could
 * sign in to the account it opens with the next code they ask for — there is nothing left to
 * withhold, and withholding it would only leave them retrying something that cannot work.
 */
const ELSEWHERE: Failure<409> = { reason: 'address-elsewhere', recovery: 'retype', status: 409 }

const SignedIn = named('SignedIn', { userId: z.uuid() })

const Offered = named('OfferedCredentials', {
  offered: z.array(z.enum(CREDENTIAL_KINDS)).readonly(),
})

/** What both screens send when they ask for one. */
const AskForCode = named('AskForCode', {
  // Folded here, at the edge, so nothing past this point has to remember to.
  email: z.email().transform(normalizeEmail).openapi({ example: 'mina@example.com' }),
  /** The caller's own key for this request. Retrying with it must not send a second mail. */
  requestKey: z.string().min(1).max(200),
})

/**
 * A code handed back, and which code it is.
 *
 * The id is in the body rather than the path, because the code is not the thing being made: what
 * comes into existence is a session on one route and a credential on the other, and the code is
 * only how somebody proves they may have it.
 */
const SubmitCode = z
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

const IssuedCode = z
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

const TooSoon = failureBody
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
type CodeRefusal = Failure<400 | 404 | 409 | 429>

/**
 * Handing a code to somebody. Three answers, because "we do not know" is a real one — the mail
 * may be in flight.
 *
 * It returns its uncertainty instead of throwing it, because a failed send must not take down a
 * code that was committed and works.
 */
export type SendCode = (to: string, code: string) => Promise<'sent' | 'refused' | 'unknown'>

type CodeRequest = {
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
type Asked =
  | { readonly kind: 'issued'; readonly body: z.infer<typeof IssuedCode> }
  /** This caller has asked for as many codes this hour as it may. Nothing is wrong with the
   *  address, and there is nothing to do but wait. */
  | {
      readonly kind: 'too-many'
      readonly body: z.infer<typeof TooSoon>
      readonly retryAfterSeconds: number
    }
  | {
      readonly kind: 'too-soon'
      readonly body: z.infer<typeof TooSoon>
      readonly retryAfterSeconds: number
    }
  | { readonly kind: 'undeliverable'; readonly body: z.infer<typeof failureBody> }

/** No letter can reach that address, so there is nothing to wait for and something to fix. */
const UNDELIVERABLE = {
  kind: 'undeliverable',
  body: { reason: 'address-refused', recovery: 'retype' },
} as const

/**
 * What either screen can be told when it asks for a code.
 *
 * Said once and spread into both routes, so the two cannot end up disagreeing about what a wait,
 * a dead address, or a live code looks like on the wire.
 */
const A_CODE_GOES_OUT = {
  201: sends(IssuedCode, 'A code is on its way, or was already sent for this request key'),
  400: refusal('The body was not the shape it claims, or no letter can reach that address'),
  429: sends(TooSoon, 'A code went out moments ago; another would break the one in the inbox'),
}

/** What either screen can be told when it hands one back. */
const A_CODE_IS_ANSWERED = {
  400: refusal('Wrong digits, or a body that was not the shape it claims'),
  404: refusal('There is no such code'),
  429: refusal('This code has no tries left'),
}

export function credentialApi(deps: CredentialApi) {
  return [
    offering(deps),
    askingToSignIn(deps),
    signingIn(deps),
    askingToAttach(deps),
    attaching(deps),
  ]
}

/** Which ways in this deployment can actually offer. A way nobody can use is not offered. */
function offering({ db, providers }: CredentialApi) {
  return anyone().get('/auth/credentials', {
    summary: 'Which ways in this deployment can actually offer',
    // Answered to a stranger on purpose: a sign-in page cannot offer a choice it cannot see.
    answers: { 200: sends(Offered, 'Everything a stranger can use to get in') },

    run: (c) => c.json({ offered: offeredKinds(providers) }, 200),
  })
}

/** Asking for a code with nobody signed in, which is how somebody becomes signed in. */
function askingToSignIn(deps: CredentialApi) {
  return anyone().post('/auth/email-codes', {
    summary: 'Ask for a code at an address',
    body: AskForCode,
    answers: A_CODE_GOES_OUT,

    run: async (c) => asksForACode(deps, 'sign-in', c, c.req.valid('json')),
  })
}

/**
 * Signing in, which is creating a session.
 *
 * Not "answering a code": what a code buys is a session, and that is the thing that comes into
 * existence. Its opposite is `DELETE /browser/sessions/current`, and now the pair reads as one.
 */
function signingIn({ db, secret, webOrigin }: CredentialApi) {
  return anyone().post('/browser/sessions', {
    summary: 'Sign in with a code, which starts a session',
    body: SubmitCode,
    answers: {
      ...A_CODE_IS_ANSWERED,
      200: sends(SignedIn, 'Signed in; the session is in a cookie the page cannot read'),
      409: refusal('This code is finished — used already, or replaced by a newer one'),
    },

    run: async (c) => {
      const codeId = whichCode(c.req.valid('json').codeId)
      if (codeId === undefined) return refused(c, explainRejection('no-code'))

      const session = newSessionToken()
      const result = await signInWithCode(db, secret, {
        codeId,
        submittedCode: c.req.valid('json').code,
        sessionTokenHash: session.hash,
      })
      if (result.kind === 'rejected') return refused(c, explainRejection(result.rejection))

      startSession(c, session.token, webOrigin)

      return c.json({ userId: result.userId }, 200)
    },
  })
}

/** Asking for a code as somebody, to add that address to the account they are already in. */
function askingToAttach(deps: CredentialApi) {
  return aPerson(deps.db).post('/me/credentials/email-codes', {
    summary: 'Ask for a code at an address, to add it to this account',
    body: AskForCode,
    answers: A_CODE_GOES_OUT,

    run: async (c) => asksForACode(deps, 'attach', c, c.req.valid('json')),
  })
}

/**
 * Adding the address, which is what answering the code is for.
 *
 * A credential comes into existence, so this is creating one — the code is how somebody proves
 * the address is theirs, not the thing being made. Its siblings read the same way: `GET /me`
 * lists them, and this puts one there.
 */
function attaching({ db, secret }: CredentialApi) {
  return aPerson(db).post('/me/credentials', {
    summary: 'Add an address to this account, by answering the code sent to it',
    body: SubmitCode,
    // An id that is not an id names no code, which is the situation a gone one is in, and gets
    // the answer that situation gets.
    instead: explainRejection('no-code'),
    answers: {
      ...A_CODE_IS_ANSWERED,
      204: 'The address now opens this account, or already did',
      409: refusal('This code is finished, or the address opens a different account'),
    },

    run: async (c) => {
      const said = c.req.valid('json')
      const codeId = whichCode(said.codeId)
      if (codeId === undefined) return refused(c, explainRejection('no-code'))

      const added = await addAddress(db, {
        secret: secret,
        user: c.get('userId'),
        answer: { codeId, code: said.code },
      })

      // Already this account's comes back attached: what was asked for is true either way.
      if (added.kind === 'attached') return nothing(c, 204)
      if (added.kind === 'rejected') return refused(c, ELSEWHERE)

      return refused(c, explainRejection(added.rejection))
    },
  })
}

/**
 * The whole of asking for a code and handing one back, whichever screen did it.
 *
 * Below the routes rather than above them: what this module *is* reads first, and this is how
 * it works.
 */

/**
 * Which code somebody means, or nothing when what arrived was not an id at all.
 *
 * Nothing, rather than a refusal: a string that is not an id names no code, which is exactly the
 * situation an expired one is in. Told "that sign-in is no longer here" a person starts again;
 * told their browser sent something malformed they have no idea what to do.
 */
function whichCode(said: string): string | undefined {
  return z.uuid().safeParse(said).success ? said : undefined
}

function explainRejection(rejection: Rejection): CodeRefusal {
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

/** Nothing is wrong, and this is how long. The only two answers that carry a number. */
function waitFor(reason: string, retryAfterSeconds: number): Asked {
  return {
    kind: reason === 'too-soon' ? 'too-soon' : 'too-many',
    body: { reason, recovery: 'wait', retryAfterSeconds },
    retryAfterSeconds,
  }
}

async function askForCode(
  sender: CredentialApi,
  send: SendCode,
  request: CodeRequest,
): Promise<Asked> {
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
  sender: CredentialApi,
  send: SendCode,
  request: CodeRequest,
  code: string,
): Promise<Awaited<ReturnType<SendCode>>> {
  const delivery = await send(request.email, code)
  await noteDelivery(sender.db, request, delivery)

  return delivery
}

/** The whole of asking, whichever screen asked and whatever the proof is for. */
async function asksForACode<E extends Env>(
  deps: CredentialApi,
  purpose: Purpose,
  c: Context<E>,
  said: z.infer<typeof AskForCode>,
) {
  const answered = await askForCode(deps, deps.sendCode, {
    ...said,
    purpose,
    askedBy: callerId(callerAddress(c, deps.trustedProxyHops)),
  })

  if (answered.kind === 'issued') return c.json(answered.body, 201)
  if (answered.kind === 'undeliverable') return c.json(answered.body, 400)

  // Both waits answer the same way: nothing is wrong, and this is how long.
  c.header('Retry-After', String(answered.retryAfterSeconds))

  return c.json(answered.body, 429)
}

/**
 * The caller's address, as far as this deployment can honestly tell.
 *
 * `X-Forwarded-For` is a list each proxy appends to, so the entry our own proxy wrote is the one
 * `hops` from the right — everything to the left of it was written by whoever was calling and can
 * say anything at all. With no proxies configured the header is ignored entirely, because an
 * unproxied deployment that read it would be counting a number the caller chose.
 */
export function callerAddress(c: Context, hops: number): string | null {
  if (hops > 0) {
    const forwarded = (c.req.header('x-forwarded-for') ?? '').split(',').map((one) => one.trim())
    const ours = forwarded.at(-hops)

    return ours === undefined || ours === '' ? null : ours
  }

  try {
    return getConnInfo(c).remote.address ?? null
  } catch {
    // Not served by the Node adapter — a request made in-process, or another runtime entirely.
    // Nobody to count, which is the honest answer: the alternative is a request that fails
    // outright because it could not be attributed.
    return null
  }
}

/**
 * The caller, in the one form it is stored in.
 *
 * A hash, because what is wanted is "the same caller as before" and nothing else. An address is
 * somebody's location; a table of them is a log of where people sign in from, kept for as long as
 * the rows live.
 */
export function callerId(address: string | null): string | null {
  return address === null ? null : createHash('sha256').update(address).digest('hex')
}
