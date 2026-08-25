import { describe, expect, it } from 'vitest'
import type { Presence } from '../machine/presence.ts'
import { working } from './busy.ts'
import { ACTIVITY } from './transcript.ts'

const HERE: Presence = { state: 'here' }
const GONE: Presence = { state: 'gone', since: new Date('2026-08-25T12:00:00Z') }

const said = { role: 'user', activityType: null }
const answered = { role: 'assistant', activityType: null }
const ended = (activityType: string) => ({ role: 'activity', activityType })

describe('whether a conversation is being worked on', () => {
  it('is idle before anybody has said anything', () => {
    expect(working(null, HERE)).toEqual({ state: 'idle' })
  })

  it('is working from the moment a person speaks, before the agent has answered anything', () => {
    // The machine has not written a word yet. Waiting for one would show a fresh question as idle.
    expect(working(said, HERE)).toEqual({ state: 'working' })
  })

  it('is still working while the agent is part way through', () => {
    expect(working(answered, HERE)).toEqual({ state: 'working' })
  })

  it('is idle once the turn is closed', () => {
    expect(working(ended(ACTIVITY.done), HERE)).toEqual({ state: 'idle' })
  })

  it('is idle after a failure, because nothing is owed until somebody speaks again', () => {
    expect(working(ended(ACTIVITY.failed), HERE)).toEqual({ state: 'idle' })
  })

  it('is idle after somebody stopped it', () => {
    expect(working(ended(ACTIVITY.cancelled), HERE)).toEqual({ state: 'idle' })
  })

  it('is unknown when the turn is open and the machine is not here', () => {
    expect(working(answered, GONE)).toEqual({ state: 'unknown' })
  })

  it('does not become unknown just because the machine left after the turn closed', () => {
    // A finished conversation on a laptop that is now shut is finished, not in doubt.
    expect(working(ended(ACTIVITY.done), GONE)).toEqual({ state: 'idle' })
  })

  it('is idle once nobody knows, because nothing more is owed until somebody speaks', () => {
    // `unknown` closes the turn. The doubt stays visible in the transcript; it is not a state the
    // conversation is stuck in, and nothing retries on its own.
    expect(working(ended(ACTIVITY.unknown), GONE)).toEqual({ state: 'idle' })
  })

  it('treats an activity it has never heard of as not closing the turn', () => {
    // New kinds of activity arrive as values. Assuming an unfamiliar one ended the turn would
    // quietly drop a question on the floor; assuming it did not leaves the turn visibly open.
    expect(working(ended('some-future-thing'), HERE)).toEqual({ state: 'working' })
  })
})
