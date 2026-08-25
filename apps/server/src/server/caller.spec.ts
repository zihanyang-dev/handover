import { describe, expect, it } from 'vitest'
import { callerAddress, callerId } from './caller.ts'
import type { Context } from 'hono'

/** A request as it arrives, with whatever headers somebody put on it. */
function arriving(headers: Record<string, string> = {}): Context {
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
  } as unknown as Context
}

describe('who is calling', () => {
  it('ignores a forwarding header when no proxy was configured', () => {
    // Unset, that header is written by whoever is calling. Trusting it turns a limit into a
    // counter anybody can reset by making one up.
    const said = arriving({ 'x-forwarded-for': '198.51.100.7' })

    expect(callerAddress(said, 0)).toBeNull()
  })

  it('reads the entry our own proxy wrote, not the ones before it', () => {
    // The header is a list each proxy appends to. Everything left of ours was written by whoever
    // was calling and can say anything at all.
    const said = arriving({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' })

    expect(callerAddress(said, 1)).toBe('203.0.113.9')
    expect(callerAddress(said, 2)).toBe('1.1.1.1')
  })

  it('is nobody when the header a proxy should have written is not there', () => {
    expect(callerAddress(arriving(), 1)).toBeNull()
  })

  it('keeps the address out of whatever is stored', () => {
    // What is wanted is "the same caller as before". An address is somebody's location, and a
    // column of them is a log of where people sign in from.
    const kept = callerId('203.0.113.9')

    expect(kept).not.toContain('203.0.113')
    expect(kept).toBe(callerId('203.0.113.9'))
    expect(kept).not.toBe(callerId('203.0.113.8'))
  })

  it('is nobody when there was nobody to identify', () => {
    expect(callerId(null)).toBeNull()
  })
})
