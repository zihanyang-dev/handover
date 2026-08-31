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
