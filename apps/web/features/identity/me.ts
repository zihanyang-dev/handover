/** Who is signed in, and everything that follows from it. One query, shared by the screens. */

import { queryOptions } from '@tanstack/react-query'
import { api } from '../../api.ts'

export const ME = ['me'] as const

export type Me = NonNullable<Awaited<ReturnType<typeof load>>>

async function load() {
  const { data } = await api.GET('/me')
  return data
}

export const meQuery = queryOptions({ queryKey: ME, queryFn: load })
