import { describe, expect, it } from 'vitest'
import {
  LIFETIME_MINUTES,
  MAX_ATTEMPTS,
  codeLetter,
  hashCode,
  newCode,
  verifyChallenge,
  type Challenge,
  type Rejection,
} from './emailed-code.ts'

const NOW = new Date('2026-08-24T12:00:00Z')
const SECRET = 's'.repeat(32)
const EMAIL = 'mina@example.com'
const CODE = '493018'

function open(overrides: Partial<Challenge> = {}): Challenge {
  return {
    email: EMAIL,
    codeHash: hashCode(EMAIL, CODE, SECRET),
    expiresAt: new Date('2026-08-24T12:05:00Z'),
    attempts: 0,
    closedReason: null,
    ...overrides,
  }
}

function rejectionOf(challenge: Challenge | undefined, code = CODE): Rejection | 'accepted' {
  const result = verifyChallenge(challenge, code, SECRET, NOW)
  return result.kind === 'accepted' ? 'accepted' : result.rejection
}

describe('verifyChallenge', () => {
  it('accepts the right code on an open challenge', () => {
    expect(rejectionOf(open())).toBe('accepted')
  })

  it('reports a challenge that is gone', () => {
    expect(rejectionOf(undefined)).toBe('no-challenge')
  })

  it('reports a code someone already signed in with', () => {
    expect(rejectionOf(open({ closedReason: 'consumed' }))).toBe('consumed')
  })

  it('reports a code past its expiry', () => {
    expect(rejectionOf(open({ expiresAt: new Date('2026-08-24T11:59:59Z') }))).toBe('expired')
  })

  it('reports a code a newer one replaced as expired, not as wrong', () => {
    expect(rejectionOf(open({ closedReason: 'superseded' }))).toBe('expired')
  })

  it('reports a challenge that ran out of tries', () => {
    expect(rejectionOf(open({ attempts: MAX_ATTEMPTS }))).toBe('attempts-exhausted')
  })

  it('reports wrong digits on a challenge that is still open', () => {
    expect(rejectionOf(open(), '000000')).toBe('code-mismatch')
  })

  it('keeps used and wrong apart even when the digits are also wrong', () => {
    expect(rejectionOf(open({ closedReason: 'consumed' }), '000000')).toBe('consumed')
  })

  it('answers finished before mistyped, because that is the more urgent fact', () => {
    const exhausted = open({ attempts: MAX_ATTEMPTS })

    expect(rejectionOf(exhausted, '000000')).toBe('attempts-exhausted')
  })

  it('rejects a code keyed to a different address', () => {
    const elsewhere = hashCode('other@example.com', CODE, SECRET)

    expect(rejectionOf(open({ codeHash: elsewhere }))).toBe('code-mismatch')
  })

  it('gives each of the five failures its own value', () => {
    const seen = new Set([
      rejectionOf(undefined),
      rejectionOf(open({ closedReason: 'consumed' })),
      rejectionOf(open({ expiresAt: new Date('2026-08-24T11:00:00Z') })),
      rejectionOf(open({ attempts: MAX_ATTEMPTS })),
      rejectionOf(open(), '000000'),
    ])

    expect(seen.size).toBe(5)
  })
})

describe('what the letter says', () => {
  it('puts the code in the subject, so it is readable from a notification', () => {
    expect(codeLetter('493018').subject).toContain('493018')
  })

  it('states the lifetime this code actually has', () => {
    // A letter that says five minutes while the code lives three is worse than a letter that
    // says nothing: somebody waits, then blames themselves for typing it wrong.
    expect(codeLetter('493018').text).toContain(`${String(LIFETIME_MINUTES)} minutes`)
  })

  it('says only the newest one works, because the last one just stopped working', () => {
    expect(codeLetter('493018').text).toMatch(/only the newest one works/i)
  })

  it('tells somebody who did not ask that ignoring it is enough', () => {
    // The one thing a person who did not ask for this needs to know, and the one thing a letter
    // like this usually leaves out.
    expect(codeLetter('493018').text).toMatch(/did not ask/i)
  })
})

describe('newCode', () => {
  it('is always six digits', () => {
    for (const code of Array.from({ length: 500 }, newCode)) expect(code).toMatch(/^\d{6}$/u)
  })

  it('reaches both ends of the range over enough draws', () => {
    const drawn = Array.from({ length: 2000 }, newCode).map(Number)

    expect(Math.min(...drawn)).toBeLessThan(200_000)
    expect(Math.max(...drawn)).toBeGreaterThan(800_000)
  })
})

describe('hashCode', () => {
  const secret = 's'.repeat(32)

  it('gives the same answer for the same inputs', () => {
    expect(hashCode('a@b.c', '000123', secret)).toBe(hashCode('a@b.c', '000123', secret))
  })

  it('is useless without the secret', () => {
    expect(hashCode('a@b.c', '000123', secret)).not.toBe(
      hashCode('a@b.c', '000123', 't'.repeat(32)),
    )
  })

  it('binds a code to the address it was sent to', () => {
    expect(hashCode('a@b.c', '000123', secret)).not.toBe(hashCode('x@b.c', '000123', secret))
  })

  it('cannot be made to collide by moving the boundary between the two inputs', () => {
    expect(hashCode('a@b.cx', '1', secret)).not.toBe(hashCode('a@b.c', 'x1', secret))
    expect(hashCode('a@b.c\u0000x', '1', secret)).not.toBe(hashCode('a@b.c', 'x\u00001', secret))
  })
})
