import { describe, expect, it } from 'vitest'
import { newEnrolmentSecret } from './secret.ts'

describe('the enrolment secret', () => {
  it('says which kind it is, so one found in a log can be traced', () => {
    expect(newEnrolmentSecret().secret).toMatch(/^hk_/u)
  })

  it('is not shaped like the credential a machine ends up holding', () => {
    // They are checked against different tables, and a machine mints its own. Sharing a prefix
    // would make a mix-up in a route look like an ordinary miss rather than a bug.
    expect(newEnrolmentSecret().secret.startsWith('hm_')).toBe(false)
  })
})
