/**
 * Reading and writing one conversation.
 *
 * A conversation being worked on is read again every second, and one that is idle is left alone.
 * Polling and not a stream, for now: what a page needs is the transcript as the server has it,
 * and a stream would be a second way of learning the same thing that could disagree with the
 * first. When latency starts to matter, only how these queries are woken changes.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, retryKey, retryKeyDone } from '../../api.ts'
import type { components } from '../../generated/api.ts'

/** Often enough that a person watching sees it move, rarely enough to be free at rest. */
const WHILE_WORKING_MS = 1000

/** One thing happening right now. Shown while it happens and kept nowhere — see the server's. */
export type Moment = components['schemas']['Moment']

/**
 * What is happening in this conversation right now.
 *
 * A stream rather than the poll, because these are the parts that never reach the transcript: what
 * it is thinking, and that it has started something. Held only while the browser is open, and
 * cleared whenever the turn settles — the transcript is what survives, and showing a finished
 * turn's live lines beside it would be showing the same words twice.
 *
 * Nothing is ever cleared here. What starts a fresh list is the caller mounting a fresh component
 * for a fresh turn, which is what a key is for — clearing it from inside would be a state change
 * during the render that noticed the turn had moved on.
 */
export function useWatching(slug: string, id: string): readonly Moment[] {
  const [moments, setMoments] = useState<readonly Moment[]>([])

  useEffect(() => {
    const live = new EventSource(`/spaces/${slug}/conversations/${id}/live`, {
      withCredentials: true,
    })

    live.onmessage = (event: MessageEvent<string>) => {
      // The heartbeat, which says only that the connection is still there.
      if (event.data === '') return
      setMoments((sofar) => [...sofar, JSON.parse(event.data) as Moment])
    }

    return () => {
      live.close()
    }
  }, [slug, id])

  return moments
}

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
      const { data, response } = await api.GET('/spaces/{slug}/conversations/{id}', {
        params: { path: { slug, id } },
      })
      // Null is "there is no such conversation here", and only a 404 means that. Everything else —
      // a session that ran out, a server that broke, a network that went — is this page failing to
      // read, and telling somebody their conversation is gone is telling them something false.
      if (response.status === 404) return null
      if (data === undefined)
        throw new Error(`could not read the conversation (${response.status})`)

      return data
    },
    // Only while something is happening. A finished conversation is finished, and asking again
    // every second would be this page pretending it might not be.
    //
    // `unknown` keeps asking too: the machine that owes an answer is not here *yet*, and when it
    // comes back it says how the turn went. Stopping there would leave the page on "nobody knows"
    // until somebody reloaded it, long after the answer had arrived.
    refetchInterval: (query) =>
      query.state.data?.working.state === 'idle' ? false : WHILE_WORKING_MS,
  })
}

/** Taken from the contract, so a kind the server does not offer cannot be asked for. */
type Opening = components['schemas']['OpenConversation']

/** What a person may choose for one question. Empty means there is nothing to choose. */
export type Model = components['schemas']['Model']

/** What was said, and what it was said with. Absent means the agent's own default, always. */
export type Saying = components['schemas']['SayThis']['asked']

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
    mutationFn: async (asked: Saying) => {
      // The whole of what was asked, not only the words. Named by the text alone, somebody whose
      // first attempt was lost and who then picked a different model would send the same name —
      // and be told it was said already, with the choice they had just made thrown away.
      const intention = `say:${id}:${JSON.stringify([asked.text, asked.model, asked.effort])}`
      const { error } = await api.POST('/spaces/{slug}/conversations/{id}/messages', {
        params: { path: { slug, id } },
        body: { key: retryKey(intention), asked },
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
