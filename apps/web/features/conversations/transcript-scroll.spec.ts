import { describe, expect, it } from 'vitest'
import {
  getLatestUserPrompt,
  shouldPinForNewPrompt,
  type TranscriptRow,
} from './transcript-scroll.ts'

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

    expect(shouldPinForNewPrompt(previous, next)).toBe(false)
  })

  it('pins when a genuinely new prompt arrives', () => {
    const previous = getLatestUserPrompt([user(1), reply(2)])
    const next = getLatestUserPrompt([user(1), reply(2), user(3)])

    expect(shouldPinForNewPrompt(previous, next)).toBe(true)
  })

  it('does not treat the first observation as a send', () => {
    expect(shouldPinForNewPrompt(null, getLatestUserPrompt([user(1)]))).toBe(false)
  })
})
