/**
 * The one way this machine talks to the server.
 *
 * A different client from the browser's, deliberately: that one rides on a cookie the browser
 * attaches, this one carries a credential this machine holds. Sharing a client would mean one
 * that does neither properly.
 */

import createClient from 'openapi-fetch'
import type { paths } from '../generated/api.ts'

export type Api = ReturnType<typeof createClient<paths>>

/** Not 503 by coincidence: to everything upstream, no answer and "no answer for you" are one thing. */
const NO_ANSWER = 503

/**
 * A `fetch` that answers instead of rejecting.
 *
 * Living on a laptop that closes its lid is this program's whole job, and `fetch` rejects when
 * there is no network. Three separate calls had already been written without remembering to catch
 * that, each crashing the command outright — which is what a rule with nothing enforcing it does.
 *
 * So it stops being a rule. The client is built on a fetch that cannot reject, and a call that
 * reached nobody comes back looking like any other answer without data. There is no longer a way
 * to write the call that forgets.
 */
async function alwaysAnswers(asking: Request): Promise<Response> {
  try {
    return await fetch(asking)
  } catch {
    // The same two fields a real refusal carries, in the same words, so nothing downstream has to
    // tell a made-up body from one the server sent.
    return Response.json({ reason: 'unreachable', recovery: 'retry-later' }, { status: NO_ANSWER })
  }
}

export function apiFor(origin: string, token?: string): Api {
  return createClient<paths>({
    baseUrl: origin,
    fetch: alwaysAnswers,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  })
}
