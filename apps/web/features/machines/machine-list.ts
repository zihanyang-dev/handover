/** The machines visible from one Space, shared by every surface that names an installed agent. */

import { queryOptions } from '@tanstack/react-query'
import { api } from '../../api.ts'

export function machinesIn(slug: string) {
  return queryOptions({
    queryKey: ['machines', slug] as const,
    // A machine appears after its own process checks in. Polling lets that happen without making
    // somebody refresh the Space they are already looking at.
    refetchInterval: 3000,
    queryFn: async () => {
      const { data, error } = await api.GET('/spaces/{slug}/machines', {
        params: { path: { slug } },
      })
      if (data === undefined) throw new Error(error.reason)
      return data.machines
    },
  })
}
