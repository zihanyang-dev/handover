import { describe, expect, it } from 'vitest'
import { POLL_SECONDS, presence, SILENT_FOR_SECONDS } from './presence.ts'

const NOW = new Date('2026-08-25T12:00:00Z')

function secondsAgo(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000)
}

describe('whether a machine is here', () => {
  it('is here while it is still checking in', () => {
    expect(presence({ lastSeenAt: secondsAgo(1), leftAt: null }, NOW)).toEqual({ state: 'here' })
  })

  it('survives one missed check-in, because that is a train tunnel', () => {
    expect(presence({ lastSeenAt: secondsAgo(POLL_SECONDS + 1), leftAt: null }, NOW)).toEqual({
      state: 'here',
    })
  })

  it('is gone once the silence outlasts two check-ins', () => {
    const lastSeenAt = secondsAgo(SILENT_FOR_SECONDS + 1)

    expect(presence({ lastSeenAt, leftAt: null }, NOW)).toEqual({
      state: 'gone',
      since: lastSeenAt,
    })
  })

  it('is still here at the exact edge, so the boundary belongs to the machine', () => {
    // Somebody has to own the boundary second. Giving it to the machine means a page never says
    // gone about one that is about to check in.
    expect(presence({ lastSeenAt: secondsAgo(SILENT_FOR_SECONDS), leftAt: null }, NOW)).toEqual({
      state: 'here',
    })
  })

  it('is gone the moment it says it is leaving, without waiting out the silence', () => {
    const leftAt = secondsAgo(1)

    expect(presence({ lastSeenAt: secondsAgo(2), leftAt }, NOW)).toEqual({
      state: 'gone',
      since: leftAt,
    })
  })

  it('reports when it left, not when it was last heard from', () => {
    // A page says "left 3 minutes ago". The last check-in before that is not what happened.
    const leftAt = secondsAgo(180)

    expect(presence({ lastSeenAt: secondsAgo(200), leftAt }, NOW)).toMatchObject({ since: leftAt })
  })

  it('believes a machine that checked in from the future rather than calling it gone', () => {
    // Clocks disagree. Trusting the machine here costs a few seconds of staleness; the other way
    // round shows a working machine as gone, which somebody would go and investigate.
    expect(presence({ lastSeenAt: new Date(NOW.getTime() + 5000), leftAt: null }, NOW)).toEqual({
      state: 'here',
    })
  })
})

describe('how long silence lasts', () => {
  it('is more than two check-ins, so a hiccup is not an outage', () => {
    expect(SILENT_FOR_SECONDS).toBeGreaterThan(POLL_SECONDS * 2)
  })
})
