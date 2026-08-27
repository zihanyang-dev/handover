import { describe, expect, it } from 'vitest'
import {
  LIFETIME_MINUTES,
  MAX_ATTEMPTS,
  codeLetter,
  hashCode,
  newCode,
  checkCode,
  type SentCode,
  type Rejection,
} from './email-code.ts'

const NOW = new Date('2026-08-24T12:00:00Z')
const SECRET = 's'.repeat(32)
const EMAIL = 'mina@example.com'

const CODE = '493018'

function live(overrides: Partial<SentCode> = {}): SentCode {
  return {
    email: EMAIL,
    codeHash: hashCode(EMAIL, CODE, SECRET),
    expiresAt: new Date('2026-08-24T12:05:00Z'),
    attempts: 0,
    closedReason: null,
    ...overrides,
  }
}

function rejectionOf(sent: SentCode | undefined, submitted = CODE): Rejection | 'accepted' {
  const result = checkCode(sent, submitted, SECRET, NOW)
  return result.kind === 'accepted' ? 'accepted' : result.rejection
}

describe('checking a code that came back', () => {
  it('accepts the right code on an open code', () => {
    expect(rejectionOf(live())).toBe('accepted')
  })

  it('reports a code that is gone', () => {
    expect(rejectionOf(undefined)).toBe('no-code')
  })

  it('reports a code someone already signed in with', () => {
    expect(rejectionOf(live({ closedReason: 'consumed' }))).toBe('consumed')
  })

  it('reports a code past its expiry', () => {
    expect(rejectionOf(live({ expiresAt: new Date('2026-08-24T11:59:59Z') }))).toBe('expired')
  })

  it('reports a code a newer one replaced as expired, not as wrong', () => {
    expect(rejectionOf(live({ closedReason: 'superseded' }))).toBe('expired')
  })

  it('reports a code that ran out of tries', () => {
    expect(rejectionOf(live({ attempts: MAX_ATTEMPTS }))).toBe('attempts-exhausted')
  })

  it('reports wrong digits on a code that is still open', () => {
    expect(rejectionOf(live(), '000000')).toBe('code-mismatch')
  })

  it('keeps used and wrong apart even when the digits are also wrong', () => {
    expect(rejectionOf(live({ closedReason: 'consumed' }), '000000')).toBe('consumed')
  })

  it('answers finished before mistyped, because that is the more urgent fact', () => {
    const exhausted = live({ attempts: MAX_ATTEMPTS })

    expect(rejectionOf(exhausted, '000000')).toBe('attempts-exhausted')
  })

  it('rejects a code keyed to a different address', () => {
    const elsewhere = hashCode('other@example.com', CODE, SECRET)

    expect(rejectionOf(live({ codeHash: elsewhere }))).toBe('code-mismatch')
  })

  it('gives each of the five failures its own value', () => {
    const seen = new Set([
      rejectionOf(undefined),
      rejectionOf(live({ closedReason: 'consumed' })),
      rejectionOf(live({ expiresAt: new Date('2026-08-24T11:00:00Z') })),
      rejectionOf(live({ attempts: MAX_ATTEMPTS })),
      rejectionOf(live(), '000000'),
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
