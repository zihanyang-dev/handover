/** Reading and writing the durable conversation transcript and its list projection. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, cached, retryKey, retryKeyDone } from '../../api.ts'
import type { components } from '../../generated/api.ts'

/**
 * How often the list of conversations asks again, while any of them is working.
 *
 * A backstop, not the way anything you do reaches the screen. What you did reaches it because the
 * call you made says so — sending invalidates this list, and so does opening a conversation — and
 * a clock is only for what somebody *else's* agent is doing, or what a handed-over piece of work
 * does between turns. Those move on the scale of a turn, not of a second.
 *
 * It was one second, which asked the heaviest recurring query in the product sixty times a minute
 * per open tab to see a flag that changes when a turn begins or ends. Nothing anybody could see
 * was lost by making it this.
 */
const WHILE_WORKING_MS = 2500

/**
 * How often to ask for a conversation anyway, while something is happening in it.
 *
 * Not how a person sees the agent move — the stream says when there is something new, and that
 * arrives in milliseconds. This is only the beat underneath it: a stream can be closed by
 * something in the middle without either end noticing, and a transcript frozen at the last thing
 * that arrived would be this page quietly showing yesterday's news.
 */
const IN_CASE_THE_STREAM_DIED_MS = 5000

/** One line of a transcript, per role. The contract's own name for it, and its own shape. */
export type Message = components['schemas']['Message']

/** One conversation as the server hands it over. The shape this page keeps and adds to. */
type Transcript = components['schemas']['Transcript']

export function conversationsIn(slug: string) {
  return cached.queryOptions(
    'get',
    '/spaces/{slug}/conversations',
    { params: { path: { slug } } },
    {
      // Same rule as one conversation: only while something is happening. This list says which of
      // them are working, and a "Working" beside one that finished a minute ago is the list saying
      // something untrue for as long as somebody leaves the page open.
      refetchInterval: (query) =>
        (query.state.data?.conversations ?? []).some((one) => one.working.state === 'working')
          ? WHILE_WORKING_MS
          : false,
      select: (answer) => answer.conversations,
    },
  )
}

/** The slot one conversation's transcript is kept in, named by the read that fills it. */
export function transcriptOf(slug: string, id: string) {
  return cached.queryOptions('get', '/spaces/{slug}/conversations/{id}', {
    params: { path: { slug, id } },
  }).queryKey
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
    // Named by the read, but not the generated read itself: what is kept here is the whole
    // transcript, and what is asked for is the part of it this page does not have.
    queryKey: transcriptOf(slug, id),
    queryFn: async ({ client, queryKey, signal }) => {
      // The client running this query, not the module's: a component may be under another one,
      // and reading the wrong cache would ask for a tail of something this screen never had.
      const sofar = client.getQueryData<Transcript | null>(queryKey)
      const held = sofar?.messages ?? []
      const last = held.at(-1)?.seq

      const { data, response } = await api.GET('/spaces/{slug}/conversations/{id}', {
        params: { path: { slug, id }, ...(last === undefined ? {} : { query: { after: last } }) },
        signal,
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
    //
    // And a piece of work that is still working keeps asking even between its turns. A
    // conversation somebody is sitting in is idle because they have not typed; one they handed
    // over is idle for the instant between one turn ending and the next beginning, and it moves
    // again without anybody doing anything. Stopping there is a page that says "Working" all
    // night about an agent that asked a question an hour ago.
    refetchInterval: (query) =>
      query.state.data?.working.state !== 'idle' || query.state.data.underway?.state === 'working'
        ? IN_CASE_THE_STREAM_DIED_MS
        : false,
  })
}

/** What was said, and what it was said with. Absent means the agent's own default, always. */
export type Saying = components['schemas']['SayThis']['asked']

/**
 * Opens a conversation by saying its first thing, which the server does as one intention.
 *
 * The id comes from the caller, so an answer nobody saw can be asked for again and finds the
 * conversation the first attempt already made — rather than a second one with the same words in
 * it. See `db/conversation.ts`.
 */
export function useBeginConversation(slug: string) {
  const client = useQueryClient()

  return cached.useMutation('post', '/spaces/{slug}/conversations', {
    onSuccess: async () => client.invalidateQueries({ queryKey: conversationsIn(slug).queryKey }),
  })
}

/** Merges an authoritative tail by its database sequence without dropping an intervening line. */
export function mergeTranscript(
  current: Transcript | null | undefined,
  tail: Transcript,
): Transcript {
  if (current === null || current === undefined) return tail

  const bySeq = new Map(current.messages.map((message) => [message.seq, message]))
  for (const message of tail.messages) bySeq.set(message.seq, message)
  const messages = [...bySeq.values()].sort((left, right) => left.seq - right.seq)
  return { ...current, ...tail, messages }
}

/**
 * Says one thing under a stable intention, then merges the authoritative accepted tail.
 *
 * The intention belongs to the words and choices, not to the click: retrying after a lost response
 * must land on the same line, while saying the same words later is a new intention.
 */
export function useSay(slug: string, id: string) {
  const client = useQueryClient()
  const queryKey = transcriptOf(slug, id)

  return useMutation<Transcript, { reason: string }, Saying>({
    mutationFn: async (asked: Saying) => {
      // The whole of what was asked, not only the words. Named by the text alone, somebody whose
      // first attempt was lost and who then picked a different model would send the same name —
      // and be told it was said already, with the choice they had just made thrown away.
      const intention = `say:${id}:${JSON.stringify([asked.text, asked.model, asked.effort])}`
      const held = client.getQueryData<Transcript | null>(queryKey)
      const after = held?.messages.at(-1)?.seq
      const { data, error } = await api.POST('/spaces/{slug}/conversations/{id}/messages', {
        params: { path: { slug, id } },
        body: { key: retryKey(intention), asked, ...(after === undefined ? {} : { after }) },
      })
      if (error !== undefined) throw error
      retryKeyDone(intention)
      client.setQueryData<Transcript | null>(queryKey, (current) => mergeTranscript(current, data))
      return data
    },
    // The list beside the transcript says which conversations are working, and this just made one
    // of them work. Said here rather than waited for, so what you did shows at once and the clock
    // above is left to what other people's agents are doing.
    onSuccess: async () => client.invalidateQueries({ queryKey: conversationsIn(slug).queryKey }),
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

  return cached.useMutation('post', '/spaces/{slug}/conversations/{id}/stop', {
    onSuccess: async () => client.invalidateQueries({ queryKey: transcriptOf(slug, id) }),
  })
}

/** Sets this person's mark on one conversation, and nobody else's. */
export function useSetPinned(slug: string, id: string) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: async (pinned: boolean) => {
      const answer = pinned
        ? await api.PUT('/spaces/{slug}/conversations/{id}/pin', {
            params: { path: { slug, id } },
          })
        : await api.DELETE('/spaces/{slug}/conversations/{id}/pin', {
            params: { path: { slug, id } },
          })
      if (!answer.response.ok) throw answer.error
    },
    onSuccess: async () => client.invalidateQueries({ queryKey: conversationsIn(slug).queryKey }),
  })
}
