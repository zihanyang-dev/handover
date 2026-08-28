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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, cached, retryKey, retryKeyDone } from '../../api.ts'
import type { components } from '../../generated/api.ts'

/** How often the browser says it is still typing, while somebody is. */
const SAYS_SO_EVERY = 2000

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

/** Whether it is being worked on, in the contract's own words. Three states, and no fourth. */
export type Working = components['schemas']['Working']

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
/**
 * The connection itself, opened once per conversation.
 *
 * Its own function so the hook above stays readable, and because what it does is one thing: a
 * browser reconnects on its own, and everything about *what* arrives belongs to the caller.
 */
function watch(slug: string, id: string): EventSource {
  return new EventSource(`/spaces/${slug}/conversations/${id}/live`, { withCredentials: true })
}

/**
 * Nothing of the last turn stays on screen when a new one begins.
 *
 * Not a key on the component, which is what this used to be: that closed the stream and opened
 * another at the start of every turn — exactly when the first moments of that turn arrive. They
 * are sent once and kept nowhere, so each one that landed in the gap was gone for good, and what
 * a person saw was a turn that began in silence.
 *
 * Remembering the last turn in state is React's own way of resetting when a prop changes: it
 * re-renders before anything is shown, and the connection above is untouched.
 */
function useStartsAgainEachTurn(turn: number, clear: (moments: readonly Moment[]) => void): void {
  const [showing, setShowing] = useState(turn)

  if (showing !== turn) {
    setShowing(turn)
    clear([])
  }
}

export function useWatching(
  slug: string,
  id: string,
  /** Which turn is running. A new one shows nothing of the last, and the list starts again. */
  turn: number,
): readonly Moment[] {
  const [moments, setMoments] = useState<readonly Moment[]>([])
  const client = useQueryClient()

  useStartsAgainEachTurn(turn, setMoments)

  useEffect(() => {
    const live = watch(slug, id)

    const read = (): void => {
      void client.invalidateQueries({ queryKey: transcriptOf(slug, id) })
    }

    // Whatever arrived while this browser was not connected arrived while it was not connected. A
    // stream that reconnects without catching up is a page that stays behind by however long it
    // was away, and neither end can tell that from an agent that went quiet.
    live.onopen = read

    live.onmessage = (event: MessageEvent<string>) => {
      if (event.data === '') return
      const watched = JSON.parse(event.data) as Watched

      if (watched.seen === 'written') read()
      else if (watched.seen === 'moment') setMoments((sofar) => [...sofar, watched.moment])
    }

    return () => {
      live.close()
    }
  }, [slug, id, client])

  return moments
}

/**
 * Says you are typing, at most once every {@link SAYS_SO_EVERY}.
 *
 * Throttled rather than debounced: what the other side needs is to keep hearing it while somebody
 * is still going, and a debounce says nothing until they stop — which is the one moment it does
 * not matter.
 *
 * Nothing is done with the answer, and a failure is swallowed on purpose: what this says is kept
 * nowhere, so one that did not arrive is a name that does not appear — exactly what it would be
 * if the person had paused. Left unhandled it is a rejected promise on every dropped connection,
 * about nothing.
 */
export function useSayingYouAreTyping(slug: string, id: string): () => void {
  const last = useRef(0)

  return () => {
    const now = Date.now()
    if (now - last.current < SAYS_SO_EVERY) return
    last.current = now

    api
      .POST('/spaces/{slug}/conversations/{id}/typing', { params: { path: { slug, id } } })
      .catch(() => undefined)
  }
}

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
    onSuccess: async () => client.invalidateQueries({ queryKey: transcriptOf(slug, id) }),
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
      if (!answer.response.ok) throw new Error('pin-not-changed')
    },
    onSuccess: async () => client.invalidateQueries({ queryKey: conversationsIn(slug).queryKey }),
  })
}

/** Everything waiting on you, across every Space. */
export function inbox() {
  return cached.queryOptions(
    'get',
    '/me/inbox',
    {},
    {
      // Often enough that somebody who leaves this open sees a piece of work stop on them, rarely
      // enough to be free. Nothing pushes here: an Inbox is read when somebody wonders, not
      // watched.
      refetchInterval: 15_000,
      select: (answer) => answer.waiting,
    },
  )
}
