import type * as oauth from 'openid-client'
import { describe, expect, it } from 'vitest'
import { identityFrom } from './google.ts'

function claims(rest: Record<string, unknown>): oauth.IDToken {
  return {
    iss: 'https://accounts.google.com',
    sub: '117',
    aud: 'handover',
    exp: 0,
    iat: 0,
    ...rest,
  }
}

describe('who Google says this is', () => {
  it('takes an address Google says it confirmed', () => {
    const identified = identityFrom(
      claims({ email: 'mina@example.com', email_verified: true, name: 'Mina Okonkwo' }),
    )

    expect(identified).toEqual({
      kind: 'identified',
      identity: {
        provider: 'google',
        subject: '117',
        verifiedEmail: 'mina@example.com',
        name: 'Mina Okonkwo',
        username: null,
      },
    })
  })

  it('never takes an address Google did not confirm', () => {
    expect(identityFrom(claims({ email: 'ceo@example.com', email_verified: false }))).toEqual({
      kind: 'no-verified-email',
    })
  })

  it('never takes an address whose confirmation was only claimed, not stated', () => {
    // Google has sent this as the string "true" before. A loose check would take it as proof.
    expect(identityFrom(claims({ email: 'ceo@example.com', email_verified: 'true' }))).toEqual({
      kind: 'no-verified-email',
    })
  })

  it('never takes an address when nothing was said about confirming it', () => {
    expect(identityFrom(claims({ email: 'ceo@example.com' }))).toEqual({
      kind: 'no-verified-email',
    })
  })

  it('has nothing to hand over when there is no token to read', () => {
    expect(identityFrom(undefined)).toEqual({ kind: 'no-verified-email' })
  })

  it('normalizes the address, so one person is not two accounts', () => {
    expect(identityFrom(claims({ email: 'Mina@Example.COM', email_verified: true }))).toMatchObject(
      { identity: { verifiedEmail: 'mina@example.com' } },
    )
  })

  it('has no name rather than a wrong one when the token carries none', () => {
    expect(identityFrom(claims({ email: 'mina@example.com', email_verified: true }))).toMatchObject(
      { identity: { name: null } },
    )
  })
})
