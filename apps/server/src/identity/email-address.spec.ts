import { describe, expect, it } from 'vitest'
import { normalizeEmail } from './email-address.ts'

describe('normalizeEmail', () => {
  it('folds case, so one inbox is one account', () => {
    expect(normalizeEmail('Mina@Example.COM')).toBe('mina@example.com')
  })

  it('drops the whitespace a paste brings with it', () => {
    expect(normalizeEmail('  mina@example.com \n')).toBe('mina@example.com')
  })

  it('leaves an already normal address alone', () => {
    expect(normalizeEmail('mina@example.com')).toBe('mina@example.com')
  })

  it('is settled after one pass', () => {
    const once = normalizeEmail('  Mina@Example.COM ')

    expect(normalizeEmail(once)).toBe(once)
  })
})
