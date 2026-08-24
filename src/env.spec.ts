import { describe, expect, it } from 'vitest'
import { parseEnv } from './env.ts'

const SECRET = 's'.repeat(32)
const URL = 'postgres://handover:handover@localhost:5443/handover_test?sslmode=disable'

describe('parseEnv', () => {
  it('returns the parsed environment', () => {
    const parsed = parseEnv({ DATABASE_URL: URL, AUTH_SECRET: SECRET })

    expect(parsed.DATABASE_URL).toBe(URL)
    expect(parsed.AUTH_SECRET).toBe(SECRET)
  })

  it('ignores names it does not declare', () => {
    const parsed = parseEnv({ DATABASE_URL: URL, AUTH_SECRET: SECRET, HOME: '/root' })

    expect(Object.keys(parsed)).not.toContain('HOME')
  })

  it('reports a missing variable by name', () => {
    expect(() => parseEnv({})).toThrow('DATABASE_URL is not set')
  })

  it('treats an empty string as absent, so it reads as missing rather than malformed', () => {
    expect(() => parseEnv({ DATABASE_URL: '', AUTH_SECRET: SECRET })).toThrow(
      'DATABASE_URL is not set',
    )
  })

  it('rejects a URL whose scheme is not postgres', () => {
    const thrown = (): unknown =>
      parseEnv({ DATABASE_URL: 'http://localhost:5432/handover', AUTH_SECRET: SECRET })
    expect(thrown).toThrow('DATABASE_URL:')
    expect(thrown).not.toThrow('is not set')
  })

  it('rejects a value that is not a URL at all', () => {
    expect(() => parseEnv({ DATABASE_URL: 'localhost:5432', AUTH_SECRET: SECRET })).toThrow(
      'DATABASE_URL:',
    )
  })

  it('falls back to the default when a number is set to nothing at all', () => {
    const parsed = parseEnv({ DATABASE_URL: URL, AUTH_SECRET: SECRET, DATABASE_POOL_MAX: '' })

    // `DATABASE_POOL_MAX=` in a file would otherwise read as "not a number" rather than "unset",
    // and the default would never apply.
    expect(parsed.DATABASE_POOL_MAX).toBe(10)
  })

  it('takes a number that is set', () => {
    const parsed = parseEnv({ DATABASE_URL: URL, AUTH_SECRET: SECRET, DATABASE_POOL_MAX: '4' })

    expect(parsed.DATABASE_POOL_MAX).toBe(4)
  })

  it('points at the file that documents the names', () => {
    expect(() => parseEnv({})).toThrow('.env.example')
  })

  it('names every problem at once, so fixing them costs one restart and not four', () => {
    const complaint = String(
      (() => {
        try {
          return parseEnv({ AUTH_SECRET: 'too-short' })
        } catch (error) {
          return error
        }
      })(),
    )

    expect(complaint).toContain('DATABASE_URL is not set')
    expect(complaint).toContain('AUTH_SECRET')
  })
})
