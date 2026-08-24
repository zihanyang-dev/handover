import { describe, expect, it } from 'vitest'
import { canonical, offeredKinds, shown, type Credential, type Shown } from './credential.ts'

function email(address: string): Credential {
  return { kind: 'email', subject: address }
}

function provider(kind: 'google' | 'github', subject = 's'): Credential {
  return { kind, subject }
}

function stateOf(rows: readonly Shown[], kind: Shown['kind']): string | undefined {
  return rows.find((way) => way.kind === kind)?.state
}

describe('the one form a credential is written in', () => {
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
    expect(offeredKinds([])).toEqual(['email'])
  })

  it('offers only the providers this deployment has keys for', () => {
    expect(offeredKinds(['google'])).toEqual(['email', 'google'])
  })
})

describe('what an account holds', () => {
  it('lists every address separately, so the number of them is visible', () => {
    // Folded into one "emailed code" line, nobody can see that two inboxes open this account —
    // and that count is the whole reason the screen exists.
    const rows = shown([email('mina@example.com'), email('zane@example.com')], [])

    expect(rows).toEqual([
      { kind: 'email', address: 'mina@example.com', state: 'ready' },
      { kind: 'email', address: 'zane@example.com', state: 'ready' },
    ])
  })

  it('keeps the order it was given, so the oldest address stays first', () => {
    const rows = shown([email('first@example.com'), email('second@example.com')], [])

    expect(rows.map((way) => (way.kind === 'email' ? way.address : way.kind))).toEqual([
      'first@example.com',
      'second@example.com',
    ])
  })

  it('marks a held provider ready and an unheld one connectable', () => {
    const rows = shown([provider('google')], ['google', 'github'])

    expect(stateOf(rows, 'google')).toBe('ready')
    expect(stateOf(rows, 'github')).toBe('connectable')
  })

  it('names every provider once, so the list cannot show one twice', () => {
    const kinds = shown([email('mina@example.com'), provider('google')], ['google', 'github']).map(
      (way) => way.kind,
    )

    expect(kinds).toEqual(['email', 'google', 'github'])
  })

  it('leaves out a provider this deployment has no keys for', () => {
    expect(shown([], ['google']).map((way) => way.kind)).toEqual(['google'])
  })

  it('still shows one somebody already holds', () => {
    // Keys were taken away after they connected it. Hiding it would leave them wondering how they
    // got in, and it does still open their account.
    expect(stateOf(shown([provider('github')], []), 'github')).toBe('ready')
  })

  it('shows nothing for an account with none, rather than inventing a row', () => {
    expect(shown([], [])).toEqual([])
  })
})
