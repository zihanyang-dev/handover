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

export function apiFor(origin: string, token?: string): Api {
  return createClient<paths>({
    baseUrl: origin,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  })
}

/**
 * A call that came back, or nothing.
 *
 * `fetch` rejects when the network is down, so without this a loop meant to sit through an outage
 * dies on the first one. Not answering is an ordinary thing for a machine that lives on somebody's
 * laptop; it is not the same as being told no.
 */
export async function answered<T>(call: Promise<T>): Promise<T | undefined> {
  try {
    return await call
  } catch {
    return undefined
  }
}
