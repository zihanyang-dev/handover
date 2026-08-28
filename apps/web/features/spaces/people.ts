/**
 * Who is in a Space, and what an owner may do about it.
 *
 * Separate from the Space itself because it is a different fact with a different lifetime: the
 * Space's name and face change once in a while and are read by every screen, while who is here
 * changes when somebody joins or is taken out and is read by the screens that say so.
 *
 * Taking somebody out is two calls on purpose, and this file is where that shows: what they still
 * hold is read *first*, as its own answer, because a machine of theirs goes with them and a piece
 * of work of theirs stops. Folded into the removal it would be a surprise after the fact.
 */

import { useQueryClient } from '@tanstack/react-query'
import { cached } from '../../api.ts'
import { machinesIn } from '../machines/machine-list.ts'

/** Everybody here, oldest membership first. Says which row is the person reading it. */
export function peopleIn(slug: string) {
  return cached.queryOptions(
    'get',
    '/spaces/{slug}/members',
    { params: { path: { slug } } },
    { select: (answer) => answer.members },
  )
}

/**
 * What is still theirs here, asked before anybody is taken out.
 *
 * Only ever asked about one person at a time, and only when somebody is about to decide — so it
 * is not part of the members list, which every screen reads.
 */
export function whatTheyHold(slug: string, userId: string) {
  return cached.queryOptions('get', '/spaces/{slug}/members/{userId}/held', {
    params: { path: { slug, userId } },
  })
}

/** Whether somebody is an owner here. Refused when it would leave the Space with none. */
export function useChangeRole(slug: string) {
  const client = useQueryClient()

  return cached.useMutation('patch', '/spaces/{slug}/members/{userId}', {
    onSuccess: async () => client.invalidateQueries({ queryKey: peopleIn(slug).queryKey }),
  })
}

/**
 * Taking somebody out, which is also how somebody leaves.
 *
 * The machines read again as well: a machine belongs to whoever connected it, so one that was
 * reachable through this person is not reachable a moment later. A list that still showed it
 * would offer an agent nobody can reach.
 */
export function useRemoveMember(slug: string) {
  const client = useQueryClient()

  return cached.useMutation('delete', '/spaces/{slug}/members/{userId}', {
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: peopleIn(slug).queryKey }),
        client.invalidateQueries({ queryKey: machinesIn(slug).queryKey }),
      ])
    },
  })
}
