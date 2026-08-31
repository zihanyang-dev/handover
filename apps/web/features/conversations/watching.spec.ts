import type { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nextLiveTurn,
  readWatched,
  streamWhileLookedAt,
  transcriptReader,
  type LiveTurn,
} from './watching.ts'

function emptyLiveTurn(): LiveTurn {
  return { activity: undefined, outputs: new Map(), typing: [] }
}

describe('live conversation events', () => {
  it('keeps ordered output separate for each tool call', () => {
    let live = emptyLiveTurn()
    live = nextLiveTurn(live, {
      said: 'doing',
      callId: 'one',
      name: 'command_execution',
      verb: 'ran',
      arg: 'pnpm test',
    })
    live = nextLiveTurn(live, { said: 'output', callId: 'one', at: 0, text: 'first' })
    live = nextLiveTurn(live, { said: 'output', callId: 'two', at: 0, text: 'other' })
    live = nextLiveTurn(live, { said: 'output', callId: 'one', at: 5, text: ' second' })

    expect(live.activity?.said).toBe('doing')
    expect(live.outputs.get('one')?.text).toBe('first second')
    expect(live.outputs.get('two')?.text).toBe('other')
  })

  it('bounds output held by the browser and marks the dropped beginning', () => {
    const tooMuch = 'x'.repeat(256 * 1024 + 10)
    const live = nextLiveTurn(emptyLiveTurn(), {
      said: 'output',
      callId: 'one',
      at: 0,
      text: tooMuch,
    })

    expect(live.outputs.get('one')).toMatchObject({
      from: 10,
      truncated: true,
    })
    expect(live.outputs.get('one')?.text).toHaveLength(256 * 1024)
  })

  it('replaces a cumulative output that restarts at zero', () => {
    let live = nextLiveTurn(emptyLiveTurn(), {
      said: 'output',
      callId: 'one',
      at: 0,
      text: 'old output',
    })
    live = nextLiveTurn(live, { said: 'output', callId: 'one', at: 0, text: 'new' })

    expect(live.outputs.get('one')).toMatchObject({ text: 'new', from: 0 })
  })

  it('ignores malformed and unknown stream payloads', () => {
    expect(readWatched('{')).toBeUndefined()
    expect(readWatched('{"seen":"later"}')).toBeUndefined()
    expect(readWatched('{"seen":"moment","moment":{"said":"output","text":"x"}}')).toBeUndefined()
    expect(
      readWatched('{"seen":"moment","moment":{"said":"output","callId":"one","at":0,"text":"x"}}'),
    ).toMatchObject({ seen: 'moment' })
  })
})

describe('transcript tail reads', () => {
  it('keeps a reconnect catch-up queued behind an in-flight announced read', async () => {
    let lastSeq = 0
    let releaseFirst: (() => void) | undefined
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const invalidateQueries = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first)
      .mockResolvedValue(undefined)
    const client = {
      getQueryData: () => (lastSeq === 0 ? { messages: [] } : { messages: [{ seq: lastSeq }] }),
      invalidateQueries,
    } as unknown as QueryClient
    const read = transcriptReader(client, ['conversation'])

    read(1)
    read()
    lastSeq = 1
    releaseFirst?.()

    await vi.waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledTimes(2)
    })
  })
})

/** One stream, answering only what the thing under test touches, so a test can drive it by hand. */
type Pretend = {
  readyState: number
  closed: boolean
  onopen: (() => void) | null
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: (() => void) | null
  close: () => void
}

/** Every stream that was opened, in order, so "it opened another one" is a thing to assert. */
function streams(): { readonly made: readonly Pretend[]; readonly open: () => EventSource } {
  const made: Pretend[] = []
  return {
    made,
    open: () => {
      const stream: Pretend = {
        readyState: EventSource.OPEN,
        closed: false,
        onopen: null,
        onmessage: null,
        onerror: null,
        close() {
          this.closed = true
          this.readyState = EventSource.CLOSED
        },
      }
      made.push(stream)
      return stream as unknown as EventSource
    },
  }
}

/** Somebody looking at the page, and the two ways they stop. */
function looking(from: DocumentVisibilityState = 'visible') {
  let state = from
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })

  return {
    away: () => {
      state = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
    },
    back: () => {
      state = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
    },
  }
}

const doingNothing = { opened: () => {}, arrived: () => {} }

describe('a stream that has to survive a trip away', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState')
    vi.useRealTimers()
  })

  it('closes the stream on the way out and opens a fresh one on the way back', () => {
    const { made, open } = streams()
    const there = looking()
    const caughtUp = vi.fn()
    streamWhileLookedAt(open, { ...doingNothing, opened: caughtUp })
    expect(made).toHaveLength(1)

    there.away()
    expect(made[0]?.closed).toBe(true)

    there.back()
    expect(made).toHaveLength(2)

    // Opening again is only worth anything because it catches the transcript up.
    made[1]?.onopen?.()
    expect(caughtUp).toHaveBeenCalledTimes(1)
  })

  it('opens again for a page restored from the back/forward cache', () => {
    const { made, open } = streams()
    looking()
    streamWhileLookedAt(open, doingNothing)

    window.dispatchEvent(new Event('pagehide'))
    expect(made[0]?.closed).toBe(true)

    window.dispatchEvent(new Event('pageshow'))
    expect(made).toHaveLength(2)
  })

  it('opens nothing at all while nobody is looking', () => {
    const { made, open } = streams()
    looking('hidden')
    streamWhileLookedAt(open, doingNothing)

    expect(made).toHaveLength(0)
  })

  it('leaves the browser to its own retry', () => {
    const { made, open } = streams()
    looking()
    streamWhileLookedAt(open, doingNothing)

    // Still connecting is the browser already trying again. A page that opened a second stream
    // here would end up with two, and be told everything twice.
    made[0]!.readyState = EventSource.CONNECTING
    made[0]?.onerror?.()

    expect(made).toHaveLength(1)
    expect(made[0]?.closed).toBe(false)
  })

  it('asks again itself once the browser has given up for good, but not at once', () => {
    vi.useFakeTimers()
    const { made, open } = streams()
    looking()
    streamWhileLookedAt(open, doingNothing)

    made[0]!.readyState = EventSource.CLOSED
    made[0]?.onerror?.()
    // Asking the instant a server said no is asking a server that is saying no as fast as it can.
    expect(made).toHaveLength(1)

    vi.advanceTimersByTime(1000)
    expect(made).toHaveLength(2)
  })

  it('waits longer each time a server keeps saying no', () => {
    vi.useFakeTimers()
    const { made, open } = streams()
    looking()
    streamWhileLookedAt(open, doingNothing)

    made[0]!.readyState = EventSource.CLOSED
    made[0]?.onerror?.()
    vi.advanceTimersByTime(1000)

    made[1]!.readyState = EventSource.CLOSED
    made[1]?.onerror?.()
    vi.advanceTimersByTime(1000)
    expect(made).toHaveLength(2)

    vi.advanceTimersByTime(1000)
    expect(made).toHaveLength(3)
  })

  it('tries at once for somebody who came back rather than making them wait it out', () => {
    vi.useFakeTimers()
    const { made, open } = streams()
    const there = looking()
    streamWhileLookedAt(open, doingNothing)

    made[0]!.readyState = EventSource.CLOSED
    made[0]?.onerror?.()

    there.away()
    there.back()
    expect(made).toHaveLength(2)
  })

  it('leaves nothing running once the page is done with it', () => {
    vi.useFakeTimers()
    const { made, open } = streams()
    looking()
    const stop = streamWhileLookedAt(open, doingNothing)

    made[0]!.readyState = EventSource.CLOSED
    made[0]?.onerror?.()
    stop()

    vi.advanceTimersByTime(60_000)
    expect(made).toHaveLength(1)
  })
})
