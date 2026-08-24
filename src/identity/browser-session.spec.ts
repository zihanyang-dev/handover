import { describe, expect, it } from 'vitest'
import { hashSessionToken, newSessionToken } from './browser-session.ts'

describe('newSessionToken', () => {
  it('never repeats a token', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newSessionToken().token))

    expect(tokens.size).toBe(200)
  })

  it('gives the hash the database stores, not the token itself', () => {
    const minted = newSessionToken()

    expect(minted.hash).toBe(hashSessionToken(minted.token))
    expect(minted.hash).not.toBe(minted.token)
  })

  it('produces a token that survives a cookie without escaping', () => {
    expect(newSessionToken().token).toMatch(/^[\w-]+$/u)
  })
})
