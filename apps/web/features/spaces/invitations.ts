/**
 * The links that let somebody into a Space.
 *
 * The plaintext of a link exists for exactly one answer: making one is the only time anybody —
 * including this server — can read it, and the list afterwards never carries it again. So the
 * screen showing it has to keep what the mutation returned, and nothing here caches it.
 */

import { useQueryClient } from '@tanstack/react-query'
import { cached } from '../../api.ts'

/** The ones that still work, newest first. Never their secrets — nobody has those any more. */
export function linksInto(slug: string) {
  return cached.queryOptions(
    'get',
    '/spaces/{slug}/invitations',
    { params: { path: { slug } } },
    { select: (answer) => answer.invitations },
  )
}

export function useMakeLink(slug: string) {
  const client = useQueryClient()

  return cached.useMutation('post', '/spaces/{slug}/invitations', {
    onSuccess: async () => client.invalidateQueries({ queryKey: linksInto(slug).queryKey }),
  })
}

/** Stopping one. Already stopped is the same answer, because it is the same end state. */
export function useStopLink(slug: string) {
  const client = useQueryClient()

  return cached.useMutation('delete', '/spaces/{slug}/invitations/{id}', {
    onSuccess: async () => client.invalidateQueries({ queryKey: linksInto(slug).queryKey }),
  })
}
