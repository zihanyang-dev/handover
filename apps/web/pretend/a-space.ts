/**
 * A Space as the screens ask for it: the three calls that page makes, answered together.
 *
 * Typed against the contract for the same reason {@link signedIn} is. Written out per file it had
 * already drifted: the Space screen grew a conversations panel and two of the three copies never
 * learned about it, so every test in one file had been quietly erroring on an unhandled request —
 * passing, because a panel that cannot read its list still renders.
 *
 * A double that can lie about the contract is worse than no double: it makes a screen pass against
 * an answer the server will never give.
 */

import { http, HttpResponse } from 'msw'
import type { components } from '../generated/api.ts'
import { signedIn } from '../pretend/signed-in.ts'

type Space = components['schemas']['Space']
type Machines = components['schemas']['Machines']
type Conversations = components['schemas']['Conversations']

export function theSpace({
  slug = 'acme',
  machines = [],
  conversations = [],
}: {
  readonly slug?: string
  readonly machines?: Machines['machines']
  readonly conversations?: Conversations['conversations']
} = {}) {
  return [
    signedIn(),
    http.get(`*/spaces/${slug}`, () =>
      HttpResponse.json<Space>({ id: 'a', slug, displayName: 'Acme' }),
    ),
    http.get(`*/spaces/${slug}/machines`, () => HttpResponse.json<Machines>({ machines })),
    http.get(`*/spaces/${slug}/conversations`, () =>
      HttpResponse.json<Conversations>({ conversations }),
    ),
  ]
}
