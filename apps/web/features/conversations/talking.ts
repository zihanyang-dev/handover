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

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, cached, retryKey, retryKeyDone } from '../../api.ts'
import type { components } from '../../generated/api.ts'

/** How often the browser says it is still typing, while somebody is. */
const SAYS_SO_EVERY = 2000
const TYPING_STAYS_FOR_MS = 5000

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

/** One thing happening right now. Shown while it happens and kept nowhere — see the server's. */
export type Moment = components['schemas']['Unkept']

/** One thing the stream carries: something happening now, or that the transcript has grown. */
type Watched = components['schemas']['Watched']

/** One line of a transcript, per role. The contract's own name for it, and its own shape. */
export type Message = components['schemas']['Message']

/** One conversation as the server hands it over. The shape this page keeps and adds to. */
type Transcript = components['schemas']['Transcript']

type Activity = Exclude<Moment, { readonly said: 'output' }>

/** A bounded piece of output held only by this browser tab. */
export type LiveOutput = {
  readonly text: string
  readonly from: number
  readonly truncated: boolean
}

type TypingPerson = { readonly id: string; readonly name: string }

/** The current status and temporary output buffers for one turn. */
export type LiveTurn = {
  readonly activity: Activity | undefined
  readonly outputs: ReadonlyMap<string, LiveOutput>
  readonly typing: readonly TypingPerson[]
}

const MAX_LIVE_OUTPUT = 256 * 1024

function emptyLiveTurn(): LiveTurn {
  return { activity: undefined, outputs: new Map(), typing: [] }
}

type OutputMoment = Extract<Moment, { readonly said: 'output' }>

function updatedOutput(previous: LiveOutput, moment: OutputMoment): LiveOutput {
  if (moment.at < previous.from) return previous
  if (moment.at === 0)
    return boundedOutput({
      text: moment.text,
      from: 0,
      truncated: moment.truncated === true,
    })

  const relativeAt = moment.at - previous.from
  if (relativeAt > previous.text.length) {
    return boundedOutput({ text: moment.text, from: moment.at, truncated: true })
  }

  const before = previous.text.slice(0, relativeAt)
  const after = previous.text.slice(relativeAt + moment.text.length)
  return boundedOutput({
    text: `${before}${moment.text}${after}`,
    from: previous.from,
    truncated: previous.truncated || moment.truncated === true,
  })
}

function boundedOutput(output: LiveOutput): LiveOutput {
  if (output.text.length <= MAX_LIVE_OUTPUT) return output

  const dropped = output.text.length - MAX_LIVE_OUTPUT
  return { text: output.text.slice(dropped), from: output.from + dropped, truncated: true }
}

/** Applies one ordered live event without retaining an ever-growing event history. */
export function nextLiveTurn(current: LiveTurn, moment: Moment): LiveTurn {
  if (moment.said !== 'output') return { ...current, activity: moment }

  const previous = current.outputs.get(moment.callId) ?? {
    text: '',
    from: 0,
    truncated: false,
  }
  const output = updatedOutput(previous, moment)
  if (output === previous) return current

  const outputs = new Map(current.outputs)
  outputs.set(moment.callId, output)
  return { ...current, outputs }
}

function jsonRecord(raw: string): Record<string, unknown> | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function isDoing(moment: Record<string, unknown>): boolean {
  const fields = ['callId', 'name', 'verb', 'arg']
  return fields.every((field) => typeof moment[field] === 'string')
}

function isOutput(moment: Record<string, unknown>): boolean {
  return (
    typeof moment['callId'] === 'string' &&
    Number.isInteger(moment['at']) &&
    Number(moment['at']) >= 0 &&
    typeof moment['text'] === 'string'
  )
}

function liveMoment(value: unknown): Moment | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const moment = value as Record<string, unknown>
  if (moment['said'] === 'thinking')
    return typeof moment['text'] === 'string' ? (value as Moment) : undefined
  if (moment['said'] === 'doing') return isDoing(moment) ? (value as Moment) : undefined
  if (moment['said'] === 'output') return isOutput(moment) ? (value as Moment) : undefined
  return undefined
}

/** Reads one live event defensively; a broken or newer event cannot break the stream handler. */
export function readWatched(raw: string): Watched | undefined {
  const value = jsonRecord(raw)
  if (value === undefined) return undefined

  if (value['seen'] === 'written') {
    const upTo = value['upTo']
    return Number.isInteger(upTo) && Number(upTo) > 0
      ? { seen: 'written', upTo: Number(upTo) }
      : undefined
  }
  if (
    value['seen'] === 'typing' &&
    typeof value['userId'] === 'string' &&
    typeof value['who'] === 'string'
  ) {
    return { seen: 'typing', userId: value['userId'], who: value['who'] }
  }
  if (value['seen'] !== 'moment') return undefined

  const moment = liveMoment(value['moment'])
  return moment === undefined ? undefined : { seen: 'moment', moment }
}

/** Opens one reconnecting connection for one conversation. */
function watch(slug: string, id: string): EventSource {
  return new EventSource(`/spaces/${slug}/conversations/${id}/live`, { withCredentials: true })
}

type TranscriptWanted =
  | { readonly kind: 'nothing' }
  | { readonly kind: 'latest' }
  | { readonly kind: 'through'; readonly seq: number }

export function transcriptReader(client: QueryClient, queryKey: QueryKey): (upTo?: number) => void {
  let wanted: TranscriptWanted = { kind: 'nothing' }
  let reading: Promise<void> | undefined

  function lastRead(): number {
    return client.getQueryData<Transcript | null>(queryKey)?.messages.at(-1)?.seq ?? 0
  }

  function want(upTo: number | undefined): void {
    if (upTo === undefined) {
      wanted = { kind: 'latest' }
      return
    }
    if (wanted.kind === 'latest') return

    const previous = wanted.kind === 'through' ? wanted.seq : 0
    wanted = { kind: 'through', seq: Math.max(previous, upTo) }
  }

  async function readOne(next: Exclude<TranscriptWanted, { readonly kind: 'nothing' }>) {
    if (next.kind === 'through' && lastRead() >= next.seq) return
    await client.invalidateQueries(
      { queryKey, exact: true, refetchType: 'active' },
      { cancelRefetch: false },
    )
  }

  async function readWanted(): Promise<void> {
    try {
      while (wanted.kind !== 'nothing') {
        const next = wanted
        wanted = { kind: 'nothing' }
        await readOne(next)
      }
    } catch {
      // The five-second authoritative read remains underneath a transient failed notification read.
    }
  }

  function start(): void {
    if (reading !== undefined || wanted.kind === 'nothing') return
    reading = readWanted().finally(() => {
      reading = undefined
      start()
    })
  }

  return (upTo) => {
    if (upTo !== undefined && wanted.kind !== 'latest' && lastRead() >= upTo) return
    want(upTo)
    start()
  }
}

function useTypingPresence(ownUserId: string | undefined): {
  readonly people: readonly TypingPerson[]
  readonly show: (person: TypingPerson) => void
  readonly clear: () => void
} {
  const [people, setPeople] = useState<readonly TypingPerson[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  /**
   * Who is reading, held rather than closed over.
   *
   * Only ever used to leave yourself out, and it arrives late: `/me` answers after this has
   * mounted, so as a dependency it changed `show` from one identity to another — and `show` is
   * what the live stream's effect depends on. The stream was therefore opened, torn down and
   * opened again on every conversation anybody opened, with a full transcript read on each.
   *
   * A ref because that is what React's own guidance is for reading the latest value inside
   * something that must not be re-created: <https://react.dev/learn/separating-events-from-effects>.
   */
  const reader = useRef(ownUserId)
  useEffect(() => {
    reader.current = ownUserId
  }, [ownUserId])

  const clear = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
    setPeople([])
  }, [])

  const show = useCallback((person: TypingPerson) => {
    if (person.id === reader.current) return
    const previous = timers.current.get(person.id)
    if (previous !== undefined) clearTimeout(previous)

    setPeople((current) =>
      current.some((one) => one.id === person.id) ? current : [...current, person],
    )
    const expire = (): void => {
      timers.current.delete(person.id)
      setPeople((current) => current.filter((one) => one.id !== person.id))
    }
    timers.current.set(person.id, setTimeout(expire, TYPING_STAYS_FOR_MS))
  }, [])

  useEffect(() => {
    const active = timers.current
    return () => {
      for (const timer of active.values()) clearTimeout(timer)
      active.clear()
    }
  }, [])

  return { people, show, clear }
}

export function useWatching(
  slug: string,
  id: string,
  /** Which turn is running. A new one shows nothing of the last, and the list starts again. */
  turn: number,
  ownUserId: string | undefined,
): { readonly liveTurn: LiveTurn; readonly startTurn: (userSeq: number) => void } {
  const [liveTurn, setLiveTurn] = useState<LiveTurn>(emptyLiveTurn)
  const showingTurn = useRef(turn)
  const { people: typing, show: showTyping, clear: clearTyping } = useTypingPresence(ownUserId)
  const client = useQueryClient()

  useLayoutEffect(() => {
    if (showingTurn.current === turn) return
    showingTurn.current = turn
    clearTyping()
    setLiveTurn(emptyLiveTurn())
  }, [clearTyping, turn])

  const startTurn = useCallback(
    (userSeq: number) => {
      showingTurn.current = userSeq
      clearTyping()
      setLiveTurn(emptyLiveTurn())
    },
    [clearTyping],
  )

  useEffect(() => {
    const live = watch(slug, id)
    const read = transcriptReader(client, transcriptOf(slug, id))

    // Whatever arrived while this browser was not connected arrived while it was not connected. A
    // stream that reconnects without catching up is a page that stays behind by however long it
    // was away, and neither end can tell that from an agent that went quiet.
    live.onopen = () => {
      read()
    }

    // Everything the server names — its heartbeat — reaches a listener for that name and never
    // this one, which is the browser's rule. So what arrives here is only ever a real frame, and
    // anything unreadable is already nothing: `readWatched` parses defensively.
    live.onmessage = (event: MessageEvent<string>) => {
      const watched = readWatched(event.data)
      if (watched === undefined) return

      if (watched.seen === 'written') read(watched.upTo)
      else if (watched.seen === 'moment')
        setLiveTurn((current) => nextLiveTurn(current, watched.moment))
      else showTyping({ id: watched.userId, name: watched.who })
    }

    return () => {
      live.close()
    }
  }, [slug, id, client, showTyping])

  return { liveTurn: { ...liveTurn, typing }, startTurn }
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
