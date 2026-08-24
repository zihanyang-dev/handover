/**
 * The one way this app talks to the server, and the one thing it has to hold on to while doing so.
 *
 * A single generic client, not a function per endpoint. The path string is checked against the
 * contract, so there is nothing to re-export and no list of calls that can fall out of step with
 * the API — the list would be the first thing to rot, and it does not exist.
 */

import createClient from 'openapi-fetch'
import type { paths } from './generated/api.ts'

export const api = createClient<paths>({ credentials: 'include' })

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
