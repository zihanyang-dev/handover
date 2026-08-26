/**
 * A key a machine with no browser comes in with.
 *
 * Making one *is* the approving: whoever made it has already decided what the code path asks a
 * person to decide later — that the machine will be theirs. It names nobody else, because a
 * machine belongs to whoever connected it and where it can be reached from follows from where
 * they are a member.
 *
 * One query rather than a mutation each screen fires its own way. A key is made once per arrival,
 * and the cache is what stops a strict-mode double mount minting two — which matters more than it
 * sounds, because each one is a way into somebody's account that only its holder can see.
 */

import { queryOptions } from '@tanstack/react-query'
import { api } from '../../api.ts'

export const MACHINE_KEY = ['machine-key'] as const

export function machineKey() {
  return queryOptions({
    queryKey: MACHINE_KEY,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data, error } = await api.POST('/me/machine-keys', {})
      if (data === undefined) throw new Error(error.reason)

      return data
    },
  })
}

/** What to run on the machine, said the same way wherever a key is shown. */
export function connectWith(key: string): string {
  return `handover connect --key ${key}`
}
