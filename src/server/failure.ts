import { HTTPException } from 'hono/http-exception'

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
  /** Nothing is wrong; a code was just sent. Give it a moment. */
  | 'wait'
  /** Nothing the person did caused this, and nothing they do fixes it. */
  | 'retry-later'

export type Failure = {
  readonly reason: string
  readonly recovery: Recovery
  readonly status: 400 | 401 | 404 | 409 | 429 | 500
}

/** Nothing about which of the two it was: an absent session and an expired one look identical. */
export const MALFORMED: Failure = { reason: 'malformed-request', recovery: 'retype', status: 400 }

export const NO_SESSION: Failure = { reason: 'no-session', recovery: 'sign-in', status: 401 }

export const NOT_A_ROUTE: Failure = { reason: 'no-such-route', recovery: 'start-over', status: 404 }

/**
 * What anything unhandled turns into. It says nothing about what broke: an error message can
 * carry a query, a value, or a path, and none of that is the caller's to see.
 */
export const BROKEN: Failure = { reason: 'unavailable', recovery: 'retry-later', status: 500 }

/** The two fields that go on the wire. The status travels beside them, not inside them. */
export function body(failure: Failure): { reason: string; recovery: Recovery } {
  return { reason: failure.reason, recovery: failure.recovery }
}

/**
 * Refuses a request that never parsed.
 *
 * The line this draws: a product outcome — wrong code, name taken, not a member — is returned,
 * because it is something the person can act on and each route says it differently. A body that
 * is not the shape it claims is not an outcome; the answer is the same everywhere and never
 * varies, so it throws once and `onError` renders it.
 */
export function refuse(failure: Failure): never {
  throw new HTTPException(failure.status, {
    res: Response.json(body(failure), { status: failure.status }),
  })
}
