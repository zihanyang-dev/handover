/**
 * Who is signed in, and everything that follows from it. One query, shared by the screens.
 *
 * It fails rather than coming back empty. Swallowed, a server that broke and a person with no
 * Spaces are the same answer to every screen that reads this — and "you have no Spaces" is a
 * sentence somebody acts on.
 */

import { api, cached } from '../../api.ts'
import type { components } from '../../generated/api.ts'

export type Me = components['schemas']['Me']

/** Nobody is signed in. Its own kind, because the recovery is a screen and not a retry. */
export class NotSignedIn extends Error {}

const asked = cached.queryOptions('get', '/me')

/** The slot this answer is kept in, for anything that changes what `/me` would say. */
export const ME = asked.queryKey

export const meQuery = {
  ...asked,
  // Its own, because "nobody is signed in" is not a failure to read: it is an answer, and the
  // screen behind it has somewhere to send that person.
  queryFn: async () => {
    const { data, response } = await api.GET('/me')
    if (response.status === 401) throw new NotSignedIn('nobody is signed in')
    if (data === undefined) throw new Error(`could not read who is signed in (${response.status})`)

    return data
  },
  // Nothing here is worth waiting through three attempts for: a session that ran out will not come
  // back, and a screen behind this one is held up for every one of them.
  retry: false,
}
