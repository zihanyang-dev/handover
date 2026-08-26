/**
 * Reading and writing one conversation.
 *
 * The transcript comes from asking, never from the live stream, and that is the split: the stream
 * carries what is happening and keeps nothing, this carries what happened and is the only thing
 * that survives. Two sources for one fact would be two facts that could disagree.
 *
 * What the stream does carry about the transcript is that it has grown. So asking is driven by
 * being told rather than by a clock — see {@link useWatching} — with a slow beat underneath it in
 * case the stream itself has quietly died. Asking again does not mean asking for all of it again;
 * see {@link useConversation}.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, retryKey, retryKeyDone } from '../../api.ts'
import type { components } from '../../generated/api.ts'

/** Often enough that a person watching the list sees it move, rarely enough to be free at rest. */
const WHILE_WORKING_MS = 1000

/**
 * How often to ask for a conversation anyway, while something is happening in it.
 *
 * Not how a person sees the agent move — the stream says when there is something new, and that
 * arrives in milliseconds. This is only the beat underneath it: a stream can be closed by
 * something in the middle without either end noticing, and a transcript frozen at the last thing
 * that arrived would be this page quietly showing yesterday's news.
 */
const IN_CASE_THE_STREAM_DIED_MS = 5000

/** One thing happening right now. Shown while it happens and kept nowhere — see the server's. */
export type Moment = components['schemas']['Unkept']

/** One thing the stream carries: something happening now, or that the transcript has grown. */
type Watched = components['schemas']['Watched']

/** One line of a transcript, per role. The contract's own name for it, and its own shape. */
export type Message = components['schemas']['Message']

/** One conversation as the server hands it over. The shape this page keeps and adds to. */
type Transcript = components['schemas']['Transcript']

/**
 * What is happening in this conversation right now, and when to go and read what was written.
 *
 * Both come down one stream because they are one thing to a person: the agent moved. Only the
 * first is shown from here — what it is thinking, and that it has started something, neither of
 * which ever reaches the transcript. The second carries no words, only that there are some, and
 * the answer to it is to ask for the tail of the transcript.
 *
 * Nothing is ever cleared here. What starts a fresh list is the caller mounting a fresh component
 * for a fresh turn, which is what a key is for — clearing it from inside would be a state change
 * during the render that noticed the turn had moved on.
 */
export function useWatching(slug: string, id: string): readonly Moment[] {
  const [moments, setMoments] = useState<readonly Moment[]>([])
  const client = useQueryClient()

  useEffect(() => {
    const live = new EventSource(`/spaces/${slug}/conversations/${id}/live`, {
      withCredentials: true,
    })

    const read = async (): Promise<void> =>
      client.invalidateQueries({ queryKey: ['conversation', slug, id] })

    // Whatever arrived while this browser was not connected arrived while it was not connected.
    // A stream that reconnects without catching up is a page that stays behind by however long it
    // was away, and neither end can tell that from an agent that went quiet.
    live.onopen = () => {
      void read()
    }

    live.onmessage = (event: MessageEvent<string>) => {
      // The heartbeat, which says only that the connection is still there.
      if (event.data === '') return

      const watched = JSON.parse(event.data) as Watched
      if (watched.seen === 'written') void read()
      else setMoments((sofar) => [...sofar, watched.moment])
    }

    return () => {
      live.close()
    }
  }, [slug, id, client])

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

/**
 * One conversation, asked for from where this page had got to.
 *
 * A transcript is only ever appended to, so what is already on screen can never be revised — and
 * asking for it again every second while somebody watches an agent work is downloading an hour of
 * their own history over and over. What comes back is the tail; what is shown is the two joined.
 *
 * Everything else in the answer — whether it is working, what there is to choose — is small and
 * comes back whole every time, because those are the parts that do change.
 */
export function useConversation(slug: string, id: string) {
  return useQuery({
    queryKey: ['conversation', slug, id] as const,
    queryFn: async ({ client, queryKey }) => {
      // The client running this query, not the module's: a component may be under another one,
      // and reading the wrong cache would ask for a tail of something this screen never had.
      const sofar = client.getQueryData<Transcript | null>(queryKey)
      const held = sofar?.messages ?? []
      const last = held.at(-1)?.seq

      const { data, response } = await api.GET('/spaces/{slug}/conversations/{id}', {
        params: { path: { slug, id }, ...(last === undefined ? {} : { query: { after: last } }) },
      })
      // Null is "there is no such conversation here", and only a 404 means that. Everything else —
      // a session that ran out, a server that broke, a network that went — is this page failing to
      // read, and telling somebody their conversation is gone is telling them something false.
      if (response.status === 404) return null
      if (data === undefined)
        throw new Error(`could not read the conversation (${response.status})`)

      return { ...data, messages: [...held, ...data.messages] }
    },
    // Only while something is happening. A finished conversation is finished, and asking again
    // every second would be this page pretending it might not be.
    //
    // `unknown` keeps asking too: the machine that owes an answer is not here *yet*, and when it
    // comes back it says how the turn went. Stopping there would leave the page on "nobody knows"
    // until somebody reloaded it, long after the answer had arrived.
    refetchInterval: (query) =>
      query.state.data?.working.state === 'idle' ? false : IN_CASE_THE_STREAM_DIED_MS,
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
