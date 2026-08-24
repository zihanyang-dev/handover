import { describe, expect, it } from 'vitest'
import { canonical, offeredWays, waysIn, type Key, type Way } from './way-in.ts'

function email(address: string): Key {
  return { kind: 'email', subject: address }
}

function provider(kind: 'google' | 'github', subject = 's'): Key {
  return { kind, subject }
}

function stateOf(ways: readonly Way[], kind: Way['kind']): string | undefined {
  return ways.find((way) => way.kind === kind)?.state
}

describe('the one form a key is written in', () => {
  it('folds an address, so one person is never two accounts', () => {
    expect(canonical(email('Mina@Example.COM'))).toEqual(email('mina@example.com'))
  })

  it("leaves a provider's own id exactly as it came", () => {
    // Theirs, not ours to reshape. Folding it would make two providers that spell ids differently
    // collide, and would not match what was written the first time either.
    expect(canonical(provider('github', 'ID-4207'))).toEqual(provider('github', 'ID-4207'))
  })
})

describe('what a stranger is offered', () => {
  it('always offers an address, because anyone can prove one', () => {
    expect(offeredWays([])).toEqual(['email'])
  })

  it('offers only the providers this deployment has keys for', () => {
    expect(offeredWays(['google'])).toEqual(['email', 'google'])
  })
})

describe('what an account holds', () => {
  it('lists every address separately, so the number of keys is visible', () => {
    // Folded into one "emailed code" line, nobody can see that two inboxes open this account —
    // and that count is the whole reason the screen exists.
    const ways = waysIn([email('mina@example.com'), email('zane@example.com')], [])

    expect(ways).toEqual([
      { kind: 'email', address: 'mina@example.com', state: 'ready' },
      { kind: 'email', address: 'zane@example.com', state: 'ready' },
    ])
  })

  it('keeps the order it was given, so the oldest address stays first', () => {
    const ways = waysIn([email('first@example.com'), email('second@example.com')], [])

    expect(ways.map((way) => (way.kind === 'email' ? way.address : way.kind))).toEqual([
      'first@example.com',
      'second@example.com',
    ])
  })

  it('marks a held provider ready and an unheld one connectable', () => {
    const ways = waysIn([provider('google')], ['google', 'github'])

    expect(stateOf(ways, 'google')).toBe('ready')
    expect(stateOf(ways, 'github')).toBe('connectable')
  })

  it('names every provider once, so the list cannot show one twice', () => {
    const kinds = waysIn([email('mina@example.com'), provider('google')], ['google', 'github']).map(
      (way) => way.kind,
    )

    expect(kinds).toEqual(['email', 'google', 'github'])
  })

  it('leaves out a provider this deployment has no keys for', () => {
    expect(waysIn([], ['google']).map((way) => way.kind)).toEqual(['google'])
  })

  it('still shows one somebody already holds', () => {
    // Keys were taken away after they connected it. Hiding it would leave them wondering how they
    // got in, and it does still open their account.
    expect(stateOf(waysIn([provider('github')], []), 'github')).toBe('ready')
  })

  it('shows nothing for an account with no keys, rather than inventing a row', () => {
    expect(waysIn([], [])).toEqual([])
  })
})
