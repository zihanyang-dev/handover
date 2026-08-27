import { describe, expect, it } from 'vitest'
import { hashSecret, mint } from './secret.ts'

describe('a secret handed out once', () => {
  it('hands out the hash of what it hands out', () => {
    const minted = mint('hx')

    expect(minted.hash).toBe(hashSecret(minted.secret))
  })

  it('never repeats itself', () => {
    const minted = Array.from({ length: 200 }, () => mint('hx').secret)

    expect(new Set(minted).size).toBe(minted.length)
  })

  it('does not put the secret in the hash', () => {
    // The tables hold hashes. If the secret were recoverable from one, the table would *be* the
    // secret, and losing it would be losing every machine and every invitation at once.
    const minted = mint('hx')

    expect(minted.hash).not.toContain(minted.secret.slice(3))
  })

  it('says which kind it is, so one found in a log can be traced back to its door', () => {
    expect(mint('hx').secret).toMatch(/^hx_/u)
  })
})
