/**
 * Which ways in this deployment offers, which the sign-in screen asks for on arrival.
 *
 * Here rather than in each test for the reason {@link theSpace} gives: written out per file it had
 * already drifted into four copies, and the two screens that reach sign-in by *failing* — a
 * session that ran out, an address sent back to be typed again — had no copy at all, so every one
 * of those tests was quietly erroring on an unhandled request and passing anyway.
 *
 * `email` is always offered: a deployment with no provider configured still has an address.
 */

import { http, HttpResponse } from 'msw'
import type { components } from '../generated/api.ts'

type Offered = components['schemas']['OfferedCredentials']

export function waysIn(...providers: readonly ('google' | 'github')[]) {
  return http.get('*/auth/credentials', () =>
    HttpResponse.json<Offered>({ offered: ['email', ...providers] }),
  )
}
