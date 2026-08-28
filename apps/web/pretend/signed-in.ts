/**
 * The `/me` handler a screen test needs before it can show anything.
 *
 * Typed against the contract, which is the whole reason it exists. Written by hand at each place
 * that needed one, this had drifted twelve ways: three were still returning a field the server
 * stopped sending, and two left out the address of an email credential — the one thing that tells
 * two of them apart, and without which React cannot key the list.
 *
 * Stable visual identity has defaults here because most screen tests are not about identity. The
 * response itself is still the complete wire shape; a caller may omit setup, never a server field.
 */

import { http, HttpResponse } from 'msw'
import type { Me } from '../features/identity/me.ts'

type Space = Me['spaces'][number]
type PretendSpace = Omit<Space, 'emoji'> & { readonly emoji?: string }
type PretendPerson = Omit<Partial<Me>, 'spaces'> & { readonly spaces?: readonly PretendSpace[] }

export function signedIn(who: PretendPerson = {}) {
  const {
    id = '00000000-0000-4000-8000-000000000001',
    avatarUrl = '/avatars/users/00000000-0000-4000-8000-000000000001',
    spaces = [],
    ...rest
  } = who

  return http.get('*/me', () =>
    HttpResponse.json<Me>({
      id,
      displayName: 'mina@example.com',
      avatarUrl,
      credentials: [],
      startedWith: 'email',
      spaces: spaces.map((space) => ({ emoji: '🏠', ...space })),
      ...rest,
    }),
  )
}
