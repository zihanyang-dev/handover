import { z } from '@hono/zod-openapi'
import { sends } from './contract.ts'

/**
 * What a failure looks like on the wire.
 *
 * Two fields, and no wording. `reason` is stable and never merges two situations a person should
 * be able to tell apart; `recovery` is the one thing they can do next. Which words say it is the
 * browser's business — a language baked in here would only be decided twice.
 */

export type Recovery =
  /** What was typed was wrong; the thing being typed into is still there. */
  | 'retype'
  /** This code is finished, the address is not. Ask for another. */
  | 'request-new-code'
  /** Nothing left to continue. Begin again from the address. */
  | 'start-over'
  /** Nobody is signed in here. */
  | 'sign-in'
  /** The name cannot be used. Pick a different one. */
  | 'choose-another-name'
  /** That agent is not on that machine any more. Install it there, or talk to a different one. */
  | 'choose-another-agent'
  /** Its machine is not here. Waiting works if it comes back; another machine works now. */
  | 'choose-another-machine'
  /** Nothing is wrong; a code was just sent. Give it a moment. */
  | 'wait'
  /** Nothing the person did caused this, and nothing they do fixes it. */
  | 'retry-later'

/** Every status a refusal is allowed to carry. A route narrows this to the ones it can answer. */
export type Status = 400 | 401 | 404 | 409 | 429 | 500

export type Failure<S extends Status = Status> = {
  readonly reason: string
  readonly recovery: Recovery
  readonly status: S
}

const RECOVERIES = [
  'retype',
  'request-new-code',
  'start-over',
  'sign-in',
  'choose-another-name',
  'choose-another-agent',
  'choose-another-machine',
  'wait',
  'retry-later',
] as const satisfies readonly Recovery[]

/** What every refusal looks like on the wire, and what a generated client branches on. */
export const failureBody = z
  .object({
    reason: z.string().openapi({ example: 'code-mismatch' }),
    recovery: z.enum(RECOVERIES),
  })
  .openapi('Failure')

export function refusal(description: string) {
  return sends(failureBody, description)
}

/**
 * The answers that come with a door rather than with a route.
 *
 * Every route behind the same door refuses the same way, and saying so at each of them is the
 * same sentence written nineteen times — nineteen places for it to drift, and no way to tell a
 * route that means something different from one that was copied.
 *
 * A route spreads the door it is behind and then says only what is its own.
 */
export const BEHIND_A_SESSION = { 401: refusal('Nobody is signed in here') } as const

export const BEHIND_A_MACHINE = {
  401: refusal('That is not a live machine credential'),
} as const

/** What any route that takes a body answers when the body is not the shape it claims. */
export const MALFORMED_BODY = {
  400: refusal('The body was not the shape it claims'),
} as const

/** Nothing about which of the two it was: an absent session and an expired one look identical. */
export const MALFORMED: Failure<400> = {
  reason: 'malformed-request',
  recovery: 'retype',
  status: 400,
}

/**
 * Nothing is here.
 *
 * Said by a Space that does not exist, a Space somebody is not in, a machine in a different Space,
 * and an id that is not an id. That is the point: telling any of them apart would turn the address
 * bar into a way of finding out what exists, and four separate copies of this is four chances for
 * one of them to start being more helpful than the others.
 */
export const UNAVAILABLE: Failure<404> = {
  reason: 'unavailable',
  recovery: 'start-over',
  status: 404,
}

export const NO_SESSION: Failure<401> = { reason: 'no-session', recovery: 'sign-in', status: 401 }

export const NOT_A_ROUTE: Failure<404> = {
  reason: 'no-such-route',
  recovery: 'start-over',
  status: 404,
}

/**
 * What anything unhandled turns into. It says nothing about what broke: an error message can
 * carry a query, a value, or a path, and none of that is the caller's to see.
 */
export const BROKEN: Failure<500> = { reason: 'unavailable', recovery: 'retry-later', status: 500 }

/** The two fields that go on the wire. The status travels beside them, not inside them. */
export function body(failure: Failure): { reason: string; recovery: Recovery } {
  return { reason: failure.reason, recovery: failure.recovery }
}
