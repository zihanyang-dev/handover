import { describe, expect, it } from 'vitest'
import { parseEnv } from './env.ts'

const SECRET = 's'.repeat(32)
const URL = 'postgres://handover:handover@localhost:5443/handover_test?sslmode=disable'

/** Everything a process must be told before it may start. */
const ENOUGH = {
  DATABASE_URL: URL,
  AUTH_SECRET: SECRET,
  NODE_ENV: 'development',
  OBJECT_STORE_BUCKET: 'handover-test',
  OBJECT_STORE_REGION: 'us-east-1',
}

describe('parseEnv', () => {
  it('returns the parsed environment', () => {
    const parsed = parseEnv(ENOUGH)

    expect(parsed.DATABASE_URL).toBe(URL)
    expect(parsed.AUTH_SECRET).toBe(SECRET)
  })

  it('ignores names it does not declare', () => {
    const parsed = parseEnv({ ...ENOUGH, HOME: '/root' })

    expect(Object.keys(parsed)).not.toContain('HOME')
  })

  it('reports a missing variable by name', () => {
    expect(() => parseEnv({})).toThrow('DATABASE_URL is not set')
  })

  it('treats an empty string as absent, so it reads as missing rather than malformed', () => {
    expect(() => parseEnv({ ...ENOUGH, DATABASE_URL: '' })).toThrow('DATABASE_URL is not set')
  })

  it('rejects a URL whose scheme is not postgres', () => {
    const thrown = (): unknown =>
      parseEnv({ ...ENOUGH, DATABASE_URL: 'http://localhost:5432/handover' })
    expect(thrown).toThrow('DATABASE_URL:')
    expect(thrown).not.toThrow('is not set')
  })

  it('rejects a value that is not a URL at all', () => {
    expect(() => parseEnv({ ...ENOUGH, DATABASE_URL: 'localhost:5432' })).toThrow('DATABASE_URL:')
  })

  it('falls back to the default when a number is set to nothing at all', () => {
    const parsed = parseEnv({ ...ENOUGH, DATABASE_POOL_MAX: '' })

    // `DATABASE_POOL_MAX=` in a file would otherwise read as "not a number" rather than "unset",
    // and the default would never apply.
    expect(parsed.DATABASE_POOL_MAX).toBe(10)
  })

  it('takes a number that is set', () => {
    const parsed = parseEnv({ ...ENOUGH, DATABASE_POOL_MAX: '4' })

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

describe('an object store set up halfway', () => {
  it('refuses an access key without its secret', () => {
    const half = { ...ENOUGH, OBJECT_STORE_ACCESS_KEY: 'an-id' }

    expect(() => parseEnv(half)).toThrow(
      'OBJECT_STORE_ACCESS_KEY and OBJECT_STORE_SECRET_KEY go together',
    )
  })

  it('keeps credentials absent for a deployment that uses a workload role', () => {
    const parsed = parseEnv(ENOUGH)

    expect(parsed.OBJECT_STORE_ACCESS_KEY).toBeUndefined()
    expect(parsed.OBJECT_STORE_FORCE_PATH_STYLE).toBe(false)
  })
})

describe('a provider set up halfway', () => {
  const whole = ENOUGH

  it('refuses an id without its secret', () => {
    const half = { ...whole, GOOGLE_CLIENT_ID: 'an-id' }

    expect(() => parseEnv(half)).toThrow('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together')
  })

  it('refuses a secret without its id', () => {
    const half = { ...whole, GITHUB_CLIENT_SECRET: 'a-secret' }

    expect(() => parseEnv(half)).toThrow('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET go together')
  })

  it('accepts a provider given both, and one given neither', () => {
    const google = { ...whole, GOOGLE_CLIENT_ID: 'an-id', GOOGLE_CLIENT_SECRET: 'a-secret' }

    expect(parseEnv(google).GOOGLE_CLIENT_ID).toBe('an-id')
    expect(parseEnv(whole).GITHUB_CLIENT_ID).toBeUndefined()
  })

  it('names every half-done provider at once, not the first one it meets', () => {
    const both = { ...whole, GOOGLE_CLIENT_ID: 'an-id', GITHUB_CLIENT_SECRET: 'a-secret' }

    const complaint = String(
      (() => {
        try {
          return parseEnv(both)
        } catch (error) {
          return error
        }
      })(),
    )

    expect(complaint).toContain('GOOGLE_CLIENT_ID')
    expect(complaint).toContain('GITHUB_CLIENT_ID')
  })
})
