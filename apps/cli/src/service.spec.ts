import { describe, expect, it } from 'vitest'
import { handoverFor, plistFor, unitFor, type ServiceSpec } from './service.ts'

function spec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    executable: '/usr/local/bin/node',
    args: ['/usr/local/lib/handover/main.js'],
    system: false,
    label: 'dev.handover.machine',
    path: '/opt/homebrew/bin:/usr/bin:/bin',
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

describe('the PATH it carries', () => {
  it('is in the unit, because a service inherits four directories and none of them have agents', () => {
    expect(unitFor(spec())).toContain('Environment="PATH=/opt/homebrew/bin:/usr/bin:/bin"')
  })

  it('is in the plist too', () => {
    expect(plistFor(spec())).toContain('<string>/opt/homebrew/bin:/usr/bin:/bin</string>')
  })
})

describe('where it goes and what runs', () => {
  it('is a login agent on a Mac somebody is using', () => {
    const handover = handoverFor(spec({ system: false }), 'darwin', '/Users/mina')

    expect(handover.path).toBe('/Users/mina/Library/LaunchAgents/dev.handover.machine.plist')
    expect(handover.steps[0]?.slice(0, 2)).toEqual(['launchctl', 'bootstrap'])
  })

  it('is a system daemon on a Mac that is a server', () => {
    expect(handoverFor(spec({ system: true }), 'darwin', '/Users/mina').path).toBe(
      '/Library/LaunchDaemons/dev.handover.machine.plist',
    )
  })

  it("is that person's own service manager on a Linux laptop", () => {
    // Not a flavour of the system one: a different manager, owned by the person rather than the
    // machine, which is exactly the difference between a laptop and a server.
    const handover = handoverFor(spec({ system: false }), 'linux', '/home/mina')

    expect(handover.path).toBe('/home/mina/.config/systemd/user/handover.service')
    expect(handover.steps).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'handover'],
    ])
  })

  it('is the machine service manager on a Linux server', () => {
    const handover = handoverFor(spec({ system: true }), 'linux', '/home/mina')

    expect(handover.path).toBe('/etc/systemd/system/handover.service')
    expect(handover.steps).toEqual([
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', '--now', 'handover'],
    ])
  })

  it('carries the file with it, so nothing has to guess what was written', () => {
    expect(handoverFor(spec(), 'linux', '/home/mina').contents).toContain('ExecStart=')
  })
})
