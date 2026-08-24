import { describe, expect, it } from 'vitest'
import { initialDisplayName } from './display-name.ts'

const EMAIL = 'mina@example.com'

describe('initialDisplayName', () => {
  it('prefers the name the provider gave', () => {
    expect(initialDisplayName({ name: 'Mina Kim', username: 'mina', verifiedEmail: EMAIL })).toBe(
      'Mina Kim',
    )
  })

  it('falls back to the username when there is no name', () => {
    expect(initialDisplayName({ name: null, username: 'mina', verifiedEmail: EMAIL })).toBe('mina')
  })

  it('falls back to the address when the provider gave neither', () => {
    expect(initialDisplayName({ name: null, username: null, verifiedEmail: EMAIL })).toBe(EMAIL)
  })

  it('treats blank and whitespace-only values as missing', () => {
    expect(initialDisplayName({ name: '', username: '   ', verifiedEmail: EMAIL })).toBe(EMAIL)
  })

  it('trims a name that is otherwise usable', () => {
    expect(initialDisplayName({ name: '  Mina Kim  ', username: null, verifiedEmail: EMAIL })).toBe(
      'Mina Kim',
    )
  })

  it('gives an emailed-code sign-in the address, with no branch of its own', () => {
    expect(initialDisplayName({ name: null, username: null, verifiedEmail: EMAIL })).toBe(EMAIL)
  })
})
