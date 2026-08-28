/**
 * One Space as a page reads it, and the one thing about it a page can change.
 *
 * Its face is here rather than beside the menu that shows it, because two surfaces show it: the
 * Space itself and the list of Spaces under `/me`. Changing it has to reach both, and a mutation
 * that lived beside one of them would be the one that forgot the other.
 */

import { queryOptions, useQueryClient } from '@tanstack/react-query'
import { api, cached } from '../../api.ts'
import { ME } from '../identity/me.ts'

const asked = (slug: string) =>
  cached.queryOptions('get', '/spaces/{slug}', { params: { path: { slug } } })

/**
 * One Space at its address.
 *
 * Its own read, because not being there is an answer rather than a failure: a Space somebody is
 * not in and a Space that does not exist are both a 404, and the screen has somewhere to send
 * them. Everything else — a session that ran out, a server that broke — is this page failing to
 * read, and saying "not available" to that would be saying something false.
 */
export function spaceQuery(slug: string) {
  return queryOptions({
    // The slot is the generated one; only the answer is ours. Written out by hand it is a second
    // spelling of the same read, and the day one of them changes they stop being one thing.
    queryKey: asked(slug).queryKey,
    queryFn: async () => {
      const { data, error, response } = await api.GET('/spaces/{slug}', {
        params: { path: { slug } },
      })
      if (response.status === 404) return null
      if (data === undefined) throw new Error(error.reason)

      return data
    },
    retry: false,
  })
}

/** Who is in this Space. */
export function peopleIn(slug: string) {
  return cached.queryOptions(
    'get',
    '/spaces/{slug}/members',
    { params: { path: { slug } } },
    { select: (answer) => answer.members },
  )
}

/**
 * Changing the face.
 *
 * Two screens show it — the Space itself, and the list of Spaces under `/me` — so both are read
 * again. Naming them from the reads themselves is the point: a slot invented here is a slot that
 * can be spelled differently there, and then one of the two quietly stops updating.
 */
export function useChangeSpaceEmoji(slug: string) {
  const client = useQueryClient()

  return cached.useMutation('patch', '/spaces/{slug}', {
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: asked(slug).queryKey }),
        client.invalidateQueries({ queryKey: ME }),
      ])
    },
  })
}
