import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk'
import { describe, expect, it } from 'vitest'
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

/** Whether this turn was asked to stop. The signal is the SDK's, and no test here reaches it. */
const asking = (asked: boolean) => ({ asked: () => asked, signal: new AbortController().signal })

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
      asking(false),
    )) {
      told.push(one)
    }

    expect(told.filter((one) => one.told === 'ended')).toHaveLength(1)
  })

  it('still says how it went when it throws without having said', async () => {
    const told = []
    for await (const one of stream(threadThat([], new Error('boom')), ASKED, asking(false))) {
      told.push(one)
    }

    expect(told).toEqual([{ told: 'ended', why: { why: 'failed', said: 'boom' } }])
  })

  it('keeps the name of an item it has never heard of', async () => {
    // Tools are open, and a branch per tool would be this file keeping a list of what Codex can
    // do — wrong the day Codex learns something new, and wrong in the quiet way, by showing
    // nothing for it. No verb, because nobody can say in a word what an unknown tool just did.
    // Deliberately not one of the SDK's own item types: what this tests is an item these types
    // have no member for, which is what a newer Codex sends the day it learns something.
    const item = { id: 'i1', item_type: 'web_search', type: 'web_search' } as unknown as ThreadItem
    const told = []
    for await (const one of stream(
      threadThat([{ type: 'item.completed', item }]),
      ASKED,
      asking(false),
    )) {
      told.push(one)
    }

    // And no verdict either: an item type this build has never seen has no field it can be read
    // out of, and a tick beside a tool that never said how it went would be invented here.
    expect(told).toContainEqual({
      told: 'said',
      said: { said: 'did', name: 'web_search', verb: '', arg: '', excerpt: '' },
    })
  })

  it('calls a turn somebody stopped cancelled, not failed', async () => {
    // What decides this is that somebody asked, not what came back. An interrupted Codex exits on
    // a signal rather than throwing an abort, so reading the ending off the throw would write the
    // one thing down as failed that a person is certain they did on purpose.
    const told = []
    for await (const one of stream(threadThat([], new Error('aborted')), ASKED, asking(true))) {
      told.push(one)
    }

    expect(told).toEqual([{ told: 'ended', why: { why: 'cancelled' } }])
  })
})
