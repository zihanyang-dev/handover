/**
 * One conversation's transient stream: live activity, bounded output, typing presence, and the
 * authoritative transcript reads that stream notifications request.
 */

import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../../api.ts'
import type { components } from '../../generated/api.ts'
import { transcriptOf } from './conversation.ts'

/** How often the browser says it is still typing, while somebody is. */
const SAYS_SO_EVERY = 2000
const TYPING_STAYS_FOR_MS = 5000

/** One thing happening right now. Shown while it happens and kept nowhere — see the server's. */
export type Moment = components['schemas']['Unkept']

/** One thing the stream carries: something happening now, or that the transcript has grown. */
type Watched = components['schemas']['Watched']

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

/** How long before asking again, after the browser has given up on a stream for good. */
const ASK_AGAIN_FROM_MS = 1000
const ASK_AGAIN_UP_TO_MS = 30_000

/** What one stream's frames mean, kept apart from the question of when there is a stream. */
type Listening = {
  readonly opened: () => void
  readonly arrived: (event: MessageEvent<string>) => void
}

/**
 * A wait that doubles up to a cap, and starts over whenever something works.
 *
 * Asking again the instant a server says no is asking as fast as that server can refuse.
 */
function slowerEachTime(from: number, upTo: number) {
  let waiting = from

  return {
    next: (): number => {
      const now = waiting
      waiting = Math.min(waiting * 2, upTo)
      return now
    },
    fromTheTop: (): void => {
      waiting = from
    },
  }
}

/**
 * What one stream means while it lasts, and the two moments outside it have to know about.
 *
 * `gaveUp` is the browser having stopped for good, and nothing else. It retries by itself, and
 * while it is doing that this has nothing to add — a second stream opened then would mean hearing
 * everything twice. The one case it will not retry is a server that answered and said no: a 401
 * whose session ran out, a 404, the wrong content type.
 */
function listenTo(
  stream: EventSource,
  listening: Listening,
  answered: () => void,
  gaveUp: () => void,
): void {
  stream.onopen = () => {
    answered()
    listening.opened()
  }
  stream.onmessage = listening.arrived
  stream.onerror = () => {
    if (stream.readyState === EventSource.CLOSED) gaveUp()
  }
}

/**
 * Keeps a stream open for exactly as long as somebody is looking at this page, and returns the way
 * to stop.
 *
 * A browser is free to freeze a tab nobody is looking at, and a frozen tab's connection dies
 * without an `error` event ever reaching the page. Nothing fires, so nothing reconnects, so the
 * catch-up an open would have done never happens — and coming back finds a stream that is only
 * pretending, on a page that quietly stopped hearing an hour ago. Closing on the way out and
 * opening on the way back is what the platform asks for, and it is also what lets the page be
 * cached at all: <https://web.dev/articles/bfcache>.
 *
 * Three events for one rule, each for a way of leaving the other two miss. `visibilitychange` is
 * the everyday one — another tab, another app, a phone going to sleep. `pagehide` is the page
 * being put away, which is the moment the connection has to be gone for the page to be kept.
 * `pageshow` is it being taken out again, and that is the one return `visibilitychange` is not
 * promised to announce.
 */
export function streamWhileLookedAt(open: () => EventSource, listening: Listening): () => void {
  let live: EventSource | undefined
  let asking: ReturnType<typeof setTimeout> | undefined
  const wait = slowerEachTime(ASK_AGAIN_FROM_MS, ASK_AGAIN_UP_TO_MS)

  function stop(): void {
    if (asking !== undefined) clearTimeout(asking)
    asking = undefined
    live?.close()
    live = undefined
  }

  function askAgain(): void {
    stop()
    asking = setTimeout(() => {
      asking = undefined
      start()
    }, wait.next())
  }

  function start(): void {
    if (live !== undefined || asking !== undefined) return
    if (document.visibilityState === 'hidden') return

    live = open()
    listenTo(live, listening, wait.fromTheTop, askAgain)
  }

  function lookedAt(): void {
    if (document.visibilityState === 'hidden') {
      stop()
      return
    }
    // Somebody is here now. Whatever wait a failed stream had earned was earned against nobody
    // watching, and making a person who just came back sit through the rest of it is the page
    // being slow at the one moment it is being looked at.
    if (asking !== undefined) clearTimeout(asking)
    asking = undefined
    wait.fromTheTop()
    start()
  }

  start()
  document.addEventListener('visibilitychange', lookedAt)
  window.addEventListener('pagehide', stop)
  window.addEventListener('pageshow', lookedAt)

  return () => {
    document.removeEventListener('visibilitychange', lookedAt)
    window.removeEventListener('pagehide', stop)
    window.removeEventListener('pageshow', lookedAt)
    stop()
  }
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
    const read = transcriptReader(client, transcriptOf(slug, id))

    return streamWhileLookedAt(() => watch(slug, id), {
      // Whatever arrived while this browser was not connected arrived while it was not connected.
      // A stream that reconnects without catching up is a page that stays behind by however long
      // it was away, and neither end can tell that from an agent that went quiet.
      opened: () => {
        read()
      },

      // Everything the server names — its heartbeat — reaches a listener for that name and never
      // this one, which is the browser's rule. So what arrives here is only ever a real frame, and
      // anything unreadable is already nothing: `readWatched` parses defensively.
      arrived: (event) => {
        const watched = readWatched(event.data)
        if (watched === undefined) return

        if (watched.seen === 'written') read(watched.upTo)
        else if (watched.seen === 'moment')
          setLiveTurn((current) => nextLiveTurn(current, watched.moment))
        else showTyping({ id: watched.userId, name: watched.who })
      },
    })
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
      // Nobody is told, because nobody would do anything about it. This says somebody is
      // typing; it is already gone in five seconds, and a failure to deliver it is the same
      // outcome as not having typed.
      .catch(() => undefined)
  }
}
