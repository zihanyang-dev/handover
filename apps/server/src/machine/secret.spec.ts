import { describe, expect, it } from 'vitest'
import { hashSecret, newEnrolmentSecret } from './secret.ts'

describe('the enrolment secret', () => {
  it('says which kind it is, so one found in a log can be traced', () => {
    expect(newEnrolmentSecret().secret).toMatch(/^hk_/u)
  })

  it('is not shaped like the credential a machine ends up holding', () => {
    // They are checked against different tables, and a machine mints its own. Sharing a prefix
    // would make a mix-up in a route look like an ordinary miss rather than a bug.
    expect(newEnrolmentSecret().secret.startsWith('hm_')).toBe(false)
  })

  it('hands out the hash of what it hands out', () => {
    const minted = newEnrolmentSecret()

    expect(minted.hash).toBe(hashSecret(minted.secret))
  })

  it('never repeats itself', () => {
    const minted = Array.from({ length: 200 }, () => newEnrolmentSecret().secret)

    expect(new Set(minted).size).toBe(minted.length)
  })

  it('does not put the secret in the hash', () => {
    // The table holds hashes. If the secret were recoverable from one, the table would be the
    // secret, and losing it would be losing every machine.
    const minted = newEnrolmentSecret()

    expect(minted.hash).not.toContain(minted.secret.slice(3))
  })
})
