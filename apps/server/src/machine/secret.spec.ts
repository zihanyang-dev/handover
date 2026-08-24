import { describe, expect, it } from 'vitest'
import { hashSecret, newEnrolmentSecret, newMachineToken } from './secret.ts'

describe('the secrets a machine holds', () => {
  it('says which kind it is, so one found in a log can be traced', () => {
    expect(newEnrolmentSecret().secret).toMatch(/^hk_/u)
    expect(newMachineToken().secret).toMatch(/^hm_/u)
  })

  it('keeps the two apart, so an enrolment secret cannot pass as a machine credential', () => {
    // They are checked against different tables. Sharing a shape would make a mix-up in a route
    // look like an ordinary miss rather than a bug.
    expect(newEnrolmentSecret().secret.startsWith(newMachineToken().secret.slice(0, 3))).toBe(false)
  })

  it('hands out the hash of what it hands out', () => {
    const minted = newMachineToken()

    expect(minted.hash).toBe(hashSecret(minted.secret))
  })

  it('never repeats itself', () => {
    const minted = Array.from({ length: 200 }, () => newMachineToken().secret)

    expect(new Set(minted).size).toBe(minted.length)
  })

  it('does not put the secret in the hash', () => {
    // The table holds hashes. If the secret were recoverable from one, the table would be the
    // secret, and losing it would be losing every machine.
    const minted = newMachineToken()

    expect(minted.hash).not.toContain(minted.secret.slice(3))
  })
})
