/**
 * What a failure looks like on the wire.
 *
 * Two fields, and no wording. `reason` is stable and never merges two situations a person should
 * be able to tell apart; `recovery` is the one thing they can do next. Which words say it is the
 * browser's business — a language baked in here would only be decided twice.
 */

import { z } from '@hono/zod-openapi'
import type { Context, Env } from 'hono'

/**
 * The one thing a person can do next, and the whole list of them.
 *
 * Written once and read both ways: the type comes from this array, and so does the enum the
 * contract publishes. Two lists — a union here and an array below it — is a recovery that can be
 * added to one and not the other, and the compiler was happy with exactly that.
 */
const RECOVERIES = [
  /** What was typed was wrong; the thing being typed into is still there. */
  'retype',
  /** This code is finished, the address is not. Ask for another. */
  'request-new-code',
  /** Nothing left to continue. Begin again from the address. */
  'start-over',
  /** Nobody is signed in here. */
  'sign-in',
  /** The name cannot be used. Pick a different one. */
  'choose-another-name',
  /** That agent is not on that machine any more. Install it there, or talk to a different one. */
  'choose-another-agent',
  /** Its machine is not here. Waiting works if it comes back; another machine works now. */
  'choose-another-machine',
  /** Nothing is wrong; a code was just sent. Give it a moment. */
  'wait',
  /** Nothing the person did caused this, and nothing they do fixes it. */
  'retry-later',
  /** Standing in the room, but this one is not theirs to do. Somebody who can, can. */
  'ask-an-owner',
] as const

export type Recovery = (typeof RECOVERIES)[number]

/** Every status a refusal is allowed to carry. A route narrows this to the ones it can answer. */
export type Status = 400 | 401 | 403 | 404 | 409 | 429 | 500

export type Failure<S extends Status = Status> = {
  readonly reason: string
  readonly recovery: Recovery
  readonly status: S
}

/** What every refusal looks like on the wire, and what a generated client branches on. */
export const failureBody = z
  .object({
    reason: z.string().openapi({ example: 'code-mismatch' }),
    recovery: z.enum(RECOVERIES),
  })
  .openapi('Failure')

/** The request could not be read at all. Nothing about which part of it, which is the caller's. */
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

export const NOT_A_ROUTE: Failure<404> = {
  reason: 'no-such-route',
  recovery: 'start-over',
  status: 404,
}

/**
 * What anything unhandled turns into. It says nothing about what broke: an error message can
 * carry a query, a value, or a path, and none of that is the caller's to see.
 */
export const BROKEN: Failure<500> = {
  // Not `unavailable`, which is what a 404 says. One word for two situations is a word a client
  // cannot branch on, and this is the one situation where nothing the caller does helps.
  reason: 'something-went-wrong',
  recovery: 'retry-later',
  status: 500,
}

/** The two fields that go on the wire. The status travels beside them, not inside them. */
function body(failure: Failure): { reason: string; recovery: Recovery } {
  return { reason: failure.reason, recovery: failure.recovery }
}

/**
 * Refuses, in the words the failure already carries.
 *
 * Both halves come from the one constant. Written out, the status is typed by hand next to a body
 * that names its own — and forty-two places to keep a pair in step is forty-two places to fall
 * out of step.
 */
export function refused<S extends Status, E extends Env>(c: Context<E>, failure: Failure<S>) {
  return c.json(body(failure), failure.status)
}
