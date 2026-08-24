import { describe, expect, it } from 'vitest'
import { waysIn, type Way } from './ways-in.ts'

function stateOf(ways: readonly Way[], kind: Way['kind']): string | undefined {
  return ways.find((way) => way.kind === kind)?.state
}

describe('waysIn', () => {
  it('always offers the emailed code, even to an account with nothing linked', () => {
    expect(stateOf(waysIn([], ['google', 'github']), 'email-code')).toBe('ready')
  })

  it('still offers the emailed code to an account with everything linked', () => {
    expect(stateOf(waysIn(['google', 'github'], ['google', 'github']), 'email-code')).toBe('ready')
  })

  it('marks a linked provider ready and an unlinked one connectable', () => {
    const ways = waysIn(['google'], ['google', 'github'])

    expect(stateOf(ways, 'google')).toBe('ready')
    expect(stateOf(ways, 'github')).toBe('connectable')
  })

  it('names every way once, so the list cannot show a provider twice', () => {
    const kinds = waysIn(['google', 'google'], ['google', 'github']).map((way) => way.kind)

    expect(kinds).toEqual(['email-code', 'google', 'github'])
  })

  it('leaves out a provider this deployment has no keys for', () => {
    const kinds = waysIn([], ['google']).map((way) => way.kind)

    expect(kinds).toEqual(['email-code', 'google'])
  })

  it('still shows one somebody is already connected through', () => {
    // Keys were taken away after they linked it. Hiding it would leave them wondering how they
    // got in, and it does still reach their account.
    expect(stateOf(waysIn(['github'], []), 'github')).toBe('ready')
  })
})
