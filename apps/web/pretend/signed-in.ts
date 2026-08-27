/**
 * The `/me` handler a screen test needs before it can show anything.
 *
 * Typed against the contract, which is the whole reason it exists. Written by hand at each place
 * that needed one, this had drifted twelve ways: three were still returning a field the server
 * stopped sending, and two left out the address of an email credential — the one thing that tells
 * two of them apart, and without which React cannot key the list.
 *
 * A double that can lie about the contract is worse than no double: it makes a screen pass against
 * an answer the server will never give.
 */

import { http, HttpResponse } from 'msw'
import type { Me } from '../features/identity/me.ts'

export function signedIn(who: Partial<Me> = {}) {
  return http.get('*/me', () =>
    HttpResponse.json<Me>({
      displayName: 'mina@example.com',
      credentials: [],
      startedWith: 'email',
      spaces: [],
      ...who,
    }),
  )
}
