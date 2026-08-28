import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api.ts'

/** One Space at its address; missing and unreachable remain different recoveries. */
export function spaceQuery(slug: string) {
  return queryOptions({
    queryKey: ['space', slug],
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

/** The Space has one face everywhere, so both ways it is cached are one invalidation. */
export function useChangeSpaceEmoji(slug: string) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: async (emoji: string) => {
      const { response } = await api.PATCH('/spaces/{slug}', {
        params: { path: { slug } },
        body: { emoji },
      })
      if (!response.ok) throw new Error('emoji-not-changed')
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['space', slug] }),
        client.invalidateQueries({ queryKey: ['me'] }),
      ])
    },
  })
}
