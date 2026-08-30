import type { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import {
  mergeTranscript,
  nextLiveTurn,
  readWatched,
  transcriptReader,
  type LiveTurn,
} from './talking.ts'

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
  it('merges the authoritative send response without losing an intervening stop line', () => {
    type Transcript = Exclude<Parameters<typeof mergeTranscript>[0], null | undefined>
    const base = {
      id: 'conversation',
      agentKind: 'codex',
      machineId: 'm-1',
      working: { state: 'idle' },
      offers: [],
    }
    const current = {
      ...base,
      messages: [
        {
          seq: 1,
          at: new Date().toISOString(),
          role: 'user',
          said: null,
          content: { text: 'first' },
        },
      ],
    } as Transcript
    const tail = {
      ...base,
      working: { state: 'working', turnId: 'turn' },
      messages: [
        {
          seq: 2,
          at: new Date().toISOString(),
          role: 'activity',
          content: { activityType: 'stop' },
        },
        {
          seq: 3,
          at: new Date().toISOString(),
          role: 'user',
          said: null,
          content: { text: 'second' },
        },
      ],
    } as Transcript

    expect(mergeTranscript(current, tail).messages.map((message) => message.seq)).toEqual([1, 2, 3])
  })

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
