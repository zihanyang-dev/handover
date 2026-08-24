import { describe, expect, it } from 'vitest'
import { plistFor, unitFor, type ServiceSpec } from './service.ts'

function spec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    executable: '/usr/local/bin/node',
    args: ['/usr/local/lib/handover/main.js'],
    system: false,
    label: 'dev.handover.machine',
    ...overrides,
  }
}

describe('the unit systemd is given', () => {
  it('starts a user service when that person logs in', () => {
    expect(unitFor(spec({ system: false }))).toContain('WantedBy=default.target')
  })

  it('starts a system service at boot, with nobody logged in', () => {
    expect(unitFor(spec({ system: true }))).toContain('WantedBy=multi-user.target')
  })

  it('runs an absolute path, never a shell', () => {
    // A typo in somebody's profile must not be able to stop a service from starting.
    const unit = unitFor(spec())

    expect(unit).toContain('ExecStart=/usr/local/bin/node /usr/local/lib/handover/main.js')
    expect(unit).not.toMatch(/ExecStart=.*(sh|bash|zsh) -/u)
  })

  it('asks to be restarted when it fails, which is the whole reason to hand it over', () => {
    expect(unitFor(spec())).toContain('Restart=on-failure')
  })
})

describe('the plist launchd is given', () => {
  it('starts at load, which for a login agent is at login', () => {
    expect(plistFor(spec())).toContain('<key>RunAtLoad</key>')
  })

  it('brings it back after a bad exit but not after a clean one', () => {
    // Stopping on purpose should stay stopped. A machine told to leave must not be dragged back
    // by the thing that is meant to keep it up.
    expect(plistFor(spec())).toContain('<key>SuccessfulExit</key>\n      <false/>')
  })

  it('passes the command as separate arguments, not one string to be re-split', () => {
    const plist = plistFor(spec({ args: ['/path/with a space/main.js'] }))

    expect(plist).toContain('<string>/usr/local/bin/node</string>')
    expect(plist).toContain('<string>/path/with a space/main.js</string>')
  })
})
