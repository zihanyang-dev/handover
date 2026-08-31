/**
 * That the rules about a transcript's words live with the words.
 *
 * The one worth a test is `sameQuestion`. It decides whether a second attempt at opening a
 * conversation is the same attempt or a different question wearing a used id, and it is asked
 * exactly once — when somebody's first message did not get an answer they saw. Get it wrong in
 * the lenient direction and a person is handed somebody else's conversation.
 */

import { describe, expect, it } from 'vitest'
import { ACTIVITY, Asked, ends, Reported, sameQuestion, wentWrong } from './transcript.ts'

const ASKED = { text: 'ship it', model: 'a-model', effort: 'high' }

describe('the same question asked again', () => {
  it('is the same however its fields were written down', () => {
    expect(sameQuestion({ effort: 'high', text: 'ship it', model: 'a-model' }, ASKED)).toBe(true)
    // Left out and set to nothing are the same thing to a person, and both mean "the agent's own".
    expect(sameQuestion({ text: 'ship it' }, { text: 'ship it' })).toBe(true)
    expect(sameQuestion({ text: 'ship it', model: undefined }, { text: 'ship it' })).toBe(true)
  })

  it('is a different question when any field a person can choose differs', () => {
    // Every field, taken from the schema rather than listed here. A fourth thing somebody may
    // choose is covered the day it is added — which is the whole reason this is not written out
    // field by field, and the failure it prevents is silent.
    for (const field of Object.keys(Asked.shape)) {
      expect(sameQuestion({ ...ASKED, [field]: 'something else' }, ASKED)).toBe(false)
    }
  })

  it('is not the same as something that is not a question at all', () => {
    expect(sameQuestion({ activityType: ACTIVITY.done }, ASKED)).toBe(false)
    expect(sameQuestion(null, ASKED)).toBe(false)
  })
})

describe('how a turn went', () => {
  const activity = (activityType: string) => ({
    role: 'activity' as const,
    content: { activityType },
  })

  it('ends on the four that close a turn, and on nothing else', () => {
    expect(ends(activity(ACTIVITY.done))).toBe(true)
    expect(ends(activity(ACTIVITY.cancelled))).toBe(true)
    expect(ends(activity(ACTIVITY.stopAsked))).toBe(false)
    expect(ends({ role: 'assistant', content: { text: 'still going' } })).toBe(false)
  })

  it('counts as trouble only what nobody asked for', () => {
    expect(wentWrong(activity(ACTIVITY.failed))).toBe(true)
    expect(wentWrong(activity(ACTIVITY.unknown))).toBe(true)
    // Somebody asked for this one, so the conversation carries on from it like anything else.
    expect(wentWrong(activity(ACTIVITY.cancelled))).toBe(false)
    expect(wentWrong(activity(ACTIVITY.done))).toBe(false)
  })
})

describe('how long a line may be', () => {
  it('refuses a tool call carrying a file rather than a glimpse of one', () => {
    const glimpse = (arg: string) =>
      Reported.safeParse({
        role: 'tool',
        content: { callId: 'one', name: 'Bash', verb: 'ran', arg, excerpt: 'ok' },
      }).success

    expect(glimpse('cat big.txt')).toBe(true)
    // What a `Bash` call was given is whatever an agent typed, and a heredoc writing a file
    // carries that file in it. Kept, this row is where a copy of the file lives — for ever.
    expect(glimpse('x'.repeat(5000))).toBe(false)
  })

  it('refuses something said that is larger than a document', () => {
    const said = (text: string) =>
      Reported.safeParse({ role: 'assistant', content: { text } }).success

    expect(said('x'.repeat(60_000))).toBe(true)
    expect(said('x'.repeat(70_000))).toBe(false)
  })
})
