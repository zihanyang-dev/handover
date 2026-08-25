/**
 * Reading and writing one conversation.
 *
 * A conversation being worked on is read again every second, and one that is idle is left alone.
 * Polling and not a stream, for now: what a page needs is the transcript as the server has it,
 * and a stream would be a second way of learning the same thing that could disagree with the
 * first. When latency starts to matter, only how these queries are woken changes.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, retryKey, retryKeyDone } from '../../api.ts'
import type { components } from '../../generated/api.ts'

/** Often enough that a person watching sees it move, rarely enough to be free at rest. */
const WHILE_WORKING_MS = 1000

export function conversationsIn(slug: string) {
  return queryOptions({
    queryKey: ['conversations', slug] as const,
    queryFn: async () => {
      const { data, error } = await api.GET('/spaces/{slug}/conversations', {
        params: { path: { slug } },
      })
      if (data === undefined) throw new Error(error.reason)
      return data.conversations
    },
    // Same rule as one conversation: only while something is happening. This list says which of
    // them are working, and a "Working" beside one that finished a minute ago is the list saying
    // something untrue for as long as somebody leaves the page open.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((one) => one.working.state === 'working')
        ? WHILE_WORKING_MS
        : false,
  })
}

export function useConversation(slug: string, id: string) {
  return useQuery({
    queryKey: ['conversation', slug, id] as const,
    queryFn: async () => {
      const { data } = await api.GET('/spaces/{slug}/conversations/{id}', {
        params: { path: { slug, id } },
      })
      return data ?? null
    },
    // Only while something is happening. A finished conversation is finished, and asking again
    // every second would be this page pretending it might not be.
    refetchInterval: (query) =>
      query.state.data?.working.state === 'working' ? WHILE_WORKING_MS : false,
  })
}

/** Taken from the contract, so a kind the server does not offer cannot be asked for. */
type Opening = components['schemas']['OpenConversation']

export function useOpenConversation(slug: string) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: async (on: Opening) => {
      const { data, error } = await api.POST('/spaces/{slug}/conversations', {
        params: { path: { slug } },
        body: on,
      })
      if (data === undefined) throw new Error(error.reason)
      return data.id
    },
    onSuccess: async () => client.invalidateQueries({ queryKey: ['conversations', slug] }),
  })
}

/**
 * Says one thing, under a name it can be said again by.
 *
 * The name belongs to the words, not to the click: an answer that never arrived leaves somebody
 * pressing Send again, and a fresh name each time would make one thing said twice. It is retired
 * once the message is in, so saying the same words again is a second message and not a repeat.
 */
export function useSay(slug: string, id: string) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: async (text: string) => {
      const intention = `say:${id}:${text}`
      const { error } = await api.POST('/spaces/{slug}/conversations/{id}/messages', {
        params: { path: { slug, id } },
        body: { key: retryKey(intention), asked: { text } },
      })
      if (error !== undefined) throw new Error(error.reason)
      retryKeyDone(intention)
    },
    onSuccess: async () => client.invalidateQueries({ queryKey: ['conversation', slug, id] }),
  })
}

/**
 * Asks it to stop the turn that is running.
 *
 * Named after that turn, so pressing Stop twice while it is still winding down is the same request
 * twice rather than two of them — the server keeps a request under the name it was given, and a
 * fresh name each time would put a second "you asked it to stop" in the transcript.
 */
export function useStop(slug: string, id: string) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: async (turn: number) => {
      const { error } = await api.POST('/spaces/{slug}/conversations/{id}/stop', {
        params: { path: { slug, id } },
        body: { key: `${String(turn)}/stop` },
      })
      if (error !== undefined) throw new Error(error.reason)
    },
    onSuccess: async () => client.invalidateQueries({ queryKey: ['conversation', slug, id] }),
  })
}
