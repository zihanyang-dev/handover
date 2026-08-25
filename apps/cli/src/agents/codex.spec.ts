import { describe, expect, it } from 'vitest'
import { reader } from './codex.ts'

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
