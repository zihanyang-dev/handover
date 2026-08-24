import { beforeEach, describe, expect, it } from 'vitest'
import { retryKey, retryKeyDone } from './api.ts'

beforeEach(() => {
  sessionStorage.clear()
})

describe('retryKey', () => {
  it('gives the same key back for the same intention', () => {
    expect(retryKey('code:mina@example.com')).toBe(retryKey('code:mina@example.com'))
  })

  it('survives what a reload does to a component', () => {
    const before = retryKey('code:mina@example.com')

    // Nothing in memory carried over; only what was written down did.
    expect(retryKey('code:mina@example.com')).toBe(before)
  })

  it('gives a different key to a different intention', () => {
    expect(retryKey('code:mina@example.com')).not.toBe(retryKey('code:rui@example.com'))
  })

  it('mints a new one once the last is done, so a resend is a new request', () => {
    const first = retryKey('code:mina@example.com')
    retryKeyDone('code:mina@example.com')

    expect(retryKey('code:mina@example.com')).not.toBe(first)
  })

  it('keeps its keys where nothing else will collide with them', () => {
    retryKey('code:mina@example.com')

    expect(Object.keys(sessionStorage)).toEqual(['handover.retry-key.code:mina@example.com'])
  })
})
