/**
 * Who is signed in, and everything that follows from it. One query, shared by the screens.
 *
 * It fails rather than coming back empty. Swallowed, a server that broke and a person with no
 * Spaces are the same answer to every screen that reads this — and "you have no Spaces" is a
 * sentence somebody acts on.
 */

import { queryOptions } from '@tanstack/react-query'
import { api } from '../../api.ts'

export const ME = ['me'] as const

export type Me = NonNullable<Awaited<ReturnType<typeof load>>>

/** Nobody is signed in. Its own kind, because the recovery is a screen and not a retry. */
export class NotSignedIn extends Error {}

async function load() {
  const { data, response } = await api.GET('/me')
  if (response.status === 401) throw new NotSignedIn('nobody is signed in')
  if (data === undefined) throw new Error(`could not read who is signed in (${response.status})`)

  return data
}

export const meQuery = queryOptions({
  queryKey: ME,
  queryFn: load,
  // Nothing here is worth waiting through three attempts for: a session that ran out will not come
  // back, and a screen behind this one is held up for every one of them.
  retry: false,
})
