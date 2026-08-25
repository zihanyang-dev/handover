import { describe, expect, it } from 'vitest'
import { working } from './busy.ts'

const HERE = { state: 'here' } as const
const GONE = { state: 'gone', since: new Date() } as const

describe('whether a conversation is being worked on', () => {
  it('is idle when every question has been answered', () => {
    expect(working(false, HERE)).toEqual({ state: 'idle' })
  })

  it('is idle even when the machine is gone, because nothing is owed', () => {
    expect(working(false, GONE)).toEqual({ state: 'idle' })
  })

  it('is working while a question is outstanding on a machine that is here', () => {
    // One nobody has taken yet and one a machine is running are the same thing from here: the
    // conversation is owed an answer, and somebody is around to give it.
    expect(working(true, HERE)).toEqual({ state: 'working' })
  })

  it('is nobody-knows when the machine that owes an answer is not here', () => {
    // Not failed. The agent may have finished the whole turn, and calling it failed would invite
    // somebody to ask for it all over again — running whatever it already did a second time.
    expect(working(true, GONE)).toEqual({ state: 'unknown' })
  })
})
