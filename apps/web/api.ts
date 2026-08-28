/**
 * The one way this app talks to the server, and the one thing it has to hold on to while doing so.
 *
 * A single generic client, not a function per endpoint. The path string is checked against the
 * contract, so there is nothing to re-export and no list of calls that can fall out of step with
 * the API — the list would be the first thing to rot, and it does not exist.
 *
 * `api` is for a call whose answer is not kept: a redirect, a sign-out, something read once.
 * Everything a screen reads again, or writes and then re-reads, goes through {@link cached}.
 */

import createClient from 'openapi-fetch'
import createQueries from 'openapi-react-query'
import type { paths } from './generated/api.ts'

export const api = createClient<paths>({ credentials: 'include' })

/**
 * The same client, for the answers that are kept.
 *
 * Every cached read and every write goes through this rather than being wrapped once per
 * endpoint: a wrapper whose whole body is "call it, unwrap it, and name the cache slot" is three
 * lines copied per call, and the name is the part that goes wrong. Here the slot is derived from
 * the method, the path and the parameters, so two screens asking the same thing cannot disagree
 * about what to call it — which they already had, three different ways.
 *
 * A hook of our own is still right where there is a **decision**: a transcript asked for from
 * where a page had got to, a refetch that only runs while something is happening, an intention
 * that must survive a lost answer. Those live beside the feature that owns them.
 */
export const cached = createQueries(api)

const RETRY_KEYS = 'handover.retry-key'

/**
 * The server promises one mail per request and one Space per request, and keeps that promise by
 * the key it is handed. Minting a fresh one on every click would break the promise from this
 * side: a lost response, a reload, an impatient second click, and one intention arrives as two.
 *
 * It lives in session storage rather than in a component, because a reload is the case it exists
 * for. Holding it is not a detail of any one screen — it is what talking to this API safely means.
 */
export function retryKey(intention: string): string {
  const slot = `${RETRY_KEYS}.${intention}`
  const held = sessionStorage.getItem(slot)
  if (held !== null) return held

  const minted = crypto.randomUUID()
  sessionStorage.setItem(slot, minted)
  return minted
}

/** Called once the intention has been carried out, so the next one is a new request. */
export function retryKeyDone(intention: string): void {
  sessionStorage.removeItem(`${RETRY_KEYS}.${intention}`)
}
