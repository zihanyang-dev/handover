import { describe, expect, it } from 'vitest'
import { identityFrom, type Account, type Address } from './github.ts'

const ACCOUNT: Account = { id: 4207, login: 'mina', name: 'Mina Okonkwo' }

function address(email: string, rest: Partial<Address> = {}): Address {
  return { email, primary: false, verified: true, ...rest }
}

describe('who GitHub says this is', () => {
  it('takes the proved address somebody made primary', () => {
    const identified = identityFrom(ACCOUNT, [
      address('spare@example.com'),
      address('mina@example.com', { primary: true }),
    ])

    expect(identified).toEqual({
      kind: 'identified',
      identity: {
        provider: 'github',
        subject: '4207',
        verifiedEmail: 'mina@example.com',
        name: 'Mina Okonkwo',
        username: 'mina',
      },
    })
  })

  it('never takes an address nobody proved, even when it is the primary one', () => {
    // Anybody can type any address into a GitHub profile. Believing it hands over the account
    // that address already reaches here.
    const identified = identityFrom(ACCOUNT, [
      address('ceo@example.com', { primary: true, verified: false }),
      address('mina@example.com'),
    ])

    expect(identified).toMatchObject({ identity: { verifiedEmail: 'mina@example.com' } })
  })

  it('has nothing to hand over when nothing was proved', () => {
    const identified = identityFrom(ACCOUNT, [
      address('ceo@example.com', { primary: true, verified: false }),
    ])

    expect(identified).toEqual({ kind: 'no-verified-email' })
  })

  it('has nothing to hand over when there are no addresses at all', () => {
    expect(identityFrom(ACCOUNT, [])).toEqual({ kind: 'no-verified-email' })
  })

  it('has nothing to hand over when the addresses could not be fetched', () => {
    // Undefined is a request that failed, not an account without addresses. Treating the two
    // differently would mean a network blip could decide who somebody is.
    expect(identityFrom(ACCOUNT, undefined)).toEqual({ kind: 'no-verified-email' })
  })

  it('has nothing to hand over when the account could not be fetched', () => {
    expect(identityFrom(undefined, [address('mina@example.com', { primary: true })])).toEqual({
      kind: 'no-verified-email',
    })
  })

  it('settles for a proved address when none is primary', () => {
    expect(identityFrom(ACCOUNT, [address('mina@example.com')])).toMatchObject({
      identity: { verifiedEmail: 'mina@example.com' },
    })
  })

  it('normalizes the address, so one person is not two accounts', () => {
    expect(identityFrom(ACCOUNT, [address('Mina@Example.COM', { primary: true })])).toMatchObject({
      identity: { verifiedEmail: 'mina@example.com' },
    })
  })

  it('keeps the login when there is no name, because a display name has to come from somewhere', () => {
    expect(
      identityFrom({ ...ACCOUNT, name: null }, [address('mina@example.com', { primary: true })]),
    ).toMatchObject({ identity: { name: null, username: 'mina' } })
  })
})
