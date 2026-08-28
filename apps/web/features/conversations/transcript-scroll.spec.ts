import { describe, expect, it } from 'vitest'
import { getLatestUserPrompt, promptToPin, type TranscriptRow } from './transcript-scroll.ts'

function user(seq: number): TranscriptRow {
  return { id: `user-${String(seq)}`, kind: 'user', seq }
}

function reply(seq: number): TranscriptRow {
  return { id: `reply-${String(seq)}`, kind: 'reply', seq }
}

describe('conversation prompt anchoring', () => {
  it('does not pin while the current answer grows', () => {
    const previous = getLatestUserPrompt([user(1)])
    const next = getLatestUserPrompt([user(1), reply(2), reply(3)])

    expect(promptToPin(previous, next)).toBeNull()
  })

  it('pins when a genuinely new prompt arrives', () => {
    const previous = getLatestUserPrompt([user(1), reply(2)])
    const next = getLatestUserPrompt([user(1), reply(2), user(3)])

    expect(promptToPin(previous, next)).toEqual(next)
  })

  it('does not treat the first observation as a send', () => {
    expect(promptToPin(null, getLatestUserPrompt([user(1)]))).toBeNull()
  })
})
