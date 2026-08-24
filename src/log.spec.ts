import { Writable } from 'node:stream'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { LOG_OPTIONS } from './log.ts'

/** A logger that writes where a test can read it, configured exactly as the real one is. */
function recording() {
  const written: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString())
      done()
    },
  })
  return {
    log: pino(LOG_OPTIONS, stream),
    lines: (): Record<string, unknown>[] =>
      written
        .flatMap((line) => line.trim().split('\n'))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

describe('the log', () => {
  it('writes one JSON object per line', () => {
    const { log, lines } = recording()

    log.info({ route: '/spaces/:slug' }, 'request')

    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toMatchObject({ level: 'info', msg: 'request', route: '/spaces/:slug' })
  })

  it('names the level rather than numbering it', () => {
    const { log, lines } = recording()

    log.error('broke')

    expect(lines()[0]).toMatchObject({ level: 'error' })
  })

  it('censors a secret that reached it by mistake', () => {
    const { log, lines } = recording()

    log.info({ token: 'the-real-session-token', secret: 'the-real-secret' }, 'signed in')

    expect(JSON.stringify(lines()[0])).not.toContain('the-real-session-token')
    expect(JSON.stringify(lines()[0])).not.toContain('the-real-secret')
  })

  it('leaves alone a name that only sometimes means a secret', () => {
    const { log, lines } = recording()

    // `code` on an error is EADDRINUSE, not somebody's six digits. Censoring it would eat the
    // useful half of a crash report and teach people to turn redaction off.
    log.error({ err: { code: 'EADDRINUSE', port: 3000 } }, 'could not listen')

    expect(JSON.stringify(lines()[0])).toContain('EADDRINUSE')
  })

  it('censors one nested inside whatever it was passed', () => {
    const { log, lines } = recording()

    log.info({ attempt: { challengeId: 'abc', tokenHash: 'deadbeef' } }, 'verifying')

    const line = JSON.stringify(lines()[0])
    expect(line).not.toContain('deadbeef')
    // Everything that is not a secret still comes through, or the line would be useless.
    expect(line).toContain('abc')
  })
})
