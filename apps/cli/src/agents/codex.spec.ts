import { describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@openai/codex-sdk'
import { reader, stream } from './codex.ts'

/** What `codex app-server` answers `model/list` with, cut down to what is read out of it. */
const REPLY = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  result: { data: [{ id: 'gpt-5.1-codex', displayName: 'GPT-5.1 Codex' }] },
})

const NOTIFICATION = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} })

describe('reading what codex says over its own protocol', () => {
  it('takes the one reply out of a stream that also carries notifications', () => {
    const read = reader()

    expect(read(`${NOTIFICATION}\n${REPLY}\n`)).toEqual([
      [{ id: 'gpt-5.1-codex', displayName: 'GPT-5.1 Codex' }],
    ])
  })

  it('holds back half a line until the rest of it arrives', () => {
    // A chunk is whatever the pipe handed over, so it can end mid-line. Read line by line without
    // keeping the remainder, a reply that arrives in two pieces is two things that will not parse.
    const read = reader()
    const [first, second] = [REPLY.slice(0, 30), REPLY.slice(30)]

    expect(read(first)).toEqual([])
    expect(read(`${second}\n`)).toEqual([[{ id: 'gpt-5.1-codex', displayName: 'GPT-5.1 Codex' }]])
  })

  it('says nothing about a reply whose last line has not ended yet', () => {
    const read = reader()

    expect(read(REPLY)).toEqual([])
  })
})

/** A thread whose events are these, and which then throws on the way out — as Codex really does. */
function threadThat(events: ThreadEvent[], throws?: unknown) {
  return {
    runStreamed: async () => ({
      events: (async function* () {
        yield* events
        if (throws !== undefined) throw throws
      })(),
    }),
  } as never
}

const ASKED = { text: 'hello' }

describe('how a turn ends', () => {
  it('ends once, even though Codex says a failure twice', async () => {
    // It reports the failed turn as an event and then throws on the way out. Announcing both
    // would close one turn twice, which today is invisible only because the caller stops reading
    // at the first ending.
    const failed = { type: 'turn.failed', error: { message: 'no' } } as ThreadEvent
    const told = []
    for await (const one of stream(
      threadThat([failed], new Error('exited 1')),
      ASKED,
      new AbortController().signal,
    )) {
      told.push(one)
    }

    expect(told.filter((one) => one.told === 'ended')).toHaveLength(1)
  })

  it('still says how it went when it throws without having said', async () => {
    const told = []
    for await (const one of stream(
      threadThat([], new Error('boom')),
      ASKED,
      new AbortController().signal,
    )) {
      told.push(one)
    }

    expect(told).toEqual([{ told: 'ended', why: { why: 'failed', said: 'boom' } }])
  })

  it('calls a turn somebody stopped cancelled, not failed', async () => {
    const stopping = new AbortController()
    stopping.abort()
    const told = []
    for await (const one of stream(threadThat([], new Error('aborted')), ASKED, stopping.signal)) {
      told.push(one)
    }

    expect(told).toEqual([{ told: 'ended', why: { why: 'cancelled' } }])
  })
})
