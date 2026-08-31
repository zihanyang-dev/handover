/**
 * A key a machine with no browser comes in with.
 *
 * Making one *is* the approving: whoever made it has already decided what the code path asks a
 * person to decide later — that the machine will be theirs. A Space-scoped screen can additionally
 * record its current Space; the key remains opaque, so the machine does not choose that scope.
 *
 * One query rather than a mutation each screen fires its own way. A key is made once per arrival,
 * and the cache is what stops a strict-mode double mount minting two — which matters more than it
 * sounds, because each one is a way into somebody's account that only its holder can see.
 */

import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, cached } from '../../api.ts'

function machineKey(space: string | undefined) {
  const request = space === undefined ? {} : { params: { query: { space } } }
  const queryKey = cached.queryOptions('post', '/me/machine-keys', request).queryKey
  return queryOptions({
    queryKey,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data, error } = await api.POST('/me/machine-keys', request)
      if (data === undefined) throw error

      return data
    },
  })
}

/**
 * What to run on the machine, said the same way wherever a key is shown.
 *
 * The address is on the line, because the line is the only thing that knows it. A downloaded
 * binary has no idea which deployment somebody meant, and a default would make it guess — see
 * `apps/cli/src/main.ts`. This is what GitHub's runner page, GitLab's runner page and Tailscale
 * all hand over too: the address and the credential, in one line nobody has to assemble.
 *
 * `location.origin` and not a value from the server: the pages and the API are the same origin,
 * forced rather than chosen, so where this page came from is where that machine should go.
 */
function connectWith(key: string): string {
  return `handover connect --origin ${globalThis.location.origin} --key ${key}`
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

export function useMachineKey(active: boolean, space?: string): Keyed {
  const client = useQueryClient()
  const options = machineKey(space)
  const key = useQuery({ ...options, enabled: active })
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
    void client.resetQueries({ queryKey: options.queryKey })
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
