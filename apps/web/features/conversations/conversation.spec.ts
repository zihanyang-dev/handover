import { describe, expect, it } from 'vitest'
import { mergeTranscript } from './conversation.ts'

describe('conversation transcript', () => {
  it('merges the authoritative send response without losing an intervening stop line', () => {
    type Transcript = Exclude<Parameters<typeof mergeTranscript>[0], null | undefined>
    const base = {
      id: 'conversation',
      agentKind: 'codex',
      machineId: 'm-1',
      working: { state: 'idle' },
      offers: [],
      earlier: false,
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
})

describe('a page of older lines and a catch-up at the same time', () => {
  type Transcript = Exclude<Parameters<typeof mergeTranscript>[0], null | undefined>

  const line = (seq: number) =>
    ({
      seq,
      at: new Date().toISOString(),
      role: 'user' as const,
      said: null,
      content: { text: `line ${seq}` },
    }) as Transcript['messages'][number]

  const transcript = (messages: readonly ReturnType<typeof line>[], earlier: boolean) =>
    ({
      id: 'conversation',
      agentKind: 'codex',
      machineId: 'm-1',
      working: { state: 'idle' },
      offers: [],
      earlier,
      messages,
    }) as unknown as Transcript

  it('keeps the older lines when the tail lands after them', () => {
    // Somebody scrolls up, the page before arrives, and a message comes in while the read that
    // fetches it is still in flight. Built from the snapshot taken before that read left, the
    // answer would be the tail on top of a transcript that no longer had the older page in it —
    // the history they just asked for, gone.
    const withOlder = transcript([line(1), line(2), line(3), line(4)], false)
    const tail = transcript([line(5)], true)

    const merged = mergeTranscript(withOlder, tail)

    expect(merged.messages.map((one) => one.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('says a line once when two reads both carry it', () => {
    const held = transcript([line(3), line(4)], true)
    const overlapping = transcript([line(4), line(5)], true)

    expect(mergeTranscript(held, overlapping).messages.map((one) => one.seq)).toEqual([3, 4, 5])
  })
})

describe('something that stops being underway', () => {
  type Transcript = Exclude<Parameters<typeof mergeTranscript>[0], null | undefined>

  const base = {
    id: 'conversation',
    agentKind: 'codex',
    machineId: 'm-1',
    working: { state: 'idle' },
    offers: [],
    earlier: false,
    messages: [],
  }

  it('is gone from the page, not kept because the answer stopped mentioning it', () => {
    // Taking work back ends the task, so the read that follows carries no `underway` key at all —
    // not the key set to nothing, the key absent. Spreading one object over another only ever
    // adds keys, so the finished piece of work survived every merge and its panel stayed on
    // screen with nothing behind it.
    const withWork = {
      ...base,
      underway: { taskId: 't-1', goal: 'add retries', state: 'wait' },
    } as unknown as Transcript
    const afterwards = { ...base } as unknown as Transcript

    expect(mergeTranscript(withWork, afterwards).underway).toBeUndefined()
  })
})
