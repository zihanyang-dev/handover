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

import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, cached } from '../../api.ts'

/** Named by the call that mints one, so nothing else can claim the same slot by accident. */
const MACHINE_KEY = cached.queryOptions('post', '/me/machine-keys', {}).queryKey

function machineKey() {
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
function connectWith(key: string): string {
  return `handover connect --key ${key}`
}

/**
 * A key, watched until it runs out.
 *
 * The behaviour lives here and the chrome does not: two screens offer a key — on the way in, and
 * from a Space that already has machines — and they look nothing alike, but a key expires the
 * same way on both. Split the other way round, one of them kept a countdown and a retry and the
 * other showed a dead command beside a button that did nothing.
 *
 * The clock is kept in state rather than read while rendering, so what is on screen changes
 * because a timer said so and not as a side effect of drawing.
 */
export type Keyed =
  | { readonly state: 'making' }
  | { readonly state: 'ready'; readonly command: string; readonly secondsLeft: number }
  /** It ran out, or one could not be made. Either way the only move is another key. */
  | { readonly state: 'expired'; readonly again: () => void }
  | { readonly state: 'unavailable'; readonly again: () => void }

export function useMachineKey(active: boolean): Keyed {
  const client = useQueryClient()
  const key = useQuery({ ...machineKey(), enabled: active })
  const [secondsLeft, setSecondsLeft] = useState<number>()

  useEffect(() => {
    if (!active || key.data === undefined) return
    const refresh = (): void => {
      setSecondsLeft(secondsUntil(key.data.expiresAt))
    }
    // Let the effect finish before updating React, then keep the visible clock honest.
    const first = setTimeout(refresh, 0)
    const timer = setInterval(refresh, 1000)

    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active, key.data])

  const again = (): void => {
    setSecondsLeft(undefined)
    void client.resetQueries({ queryKey: MACHINE_KEY })
  }

  if (key.isError) return { state: 'unavailable', again }
  if (secondsLeft === 0) return { state: 'expired', again }
  if (key.data === undefined || secondsLeft === undefined) return { state: 'making' }

  return { state: 'ready', command: connectWith(key.data.key), secondsLeft }
}

/** How long this key has, in whole seconds, never below zero. */
function secondsUntil(expiresAt: string): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000))
}
