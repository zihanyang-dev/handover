import { describe, expect, it } from 'vitest'
import { forEveryone, handoverFor, plistFor, unitFor, type ServiceSpec } from './service.ts'

function spec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    executable: '/usr/local/bin/node',
    args: ['/usr/local/lib/handover/main.js'],
    system: false,
    label: 'dev.handover.machine',
    path: '/opt/homebrew/bin:/usr/bin:/bin',
    where: '/Users/mina/work/payments',
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

    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/usr/local/lib/handover/main.js"')
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

describe('a path with something in it that a service file reads', () => {
  // Both of these are somebody's home directory and wherever they installed this, so neither is
  // ours to assume anything about. A file that will not parse is a machine that never comes back
  // after a reboot, with nothing anywhere saying why.
  it('keeps a space out of the argument splitting, in the unit', () => {
    const unit = unitFor(spec({ executable: '/Users/mina/My Tools/node' }))

    expect(unit).toContain('ExecStart="/Users/mina/My Tools/node"')
  })

  it('doubles a per-cent, which systemd would otherwise read as a specifier', () => {
    expect(unitFor(spec({ path: '/opt/100%/bin' }))).toContain('Environment="PATH=/opt/100%%/bin"')
  })

  it('escapes an ampersand, which would leave launchd unable to parse the file at all', () => {
    expect(plistFor(spec({ path: '/opt/r&d/bin' }))).toContain('<string>/opt/r&amp;d/bin</string>')
  })
})

describe('the directory it works in', () => {
  // Nobody chooses it and nothing asks: it is where `handover connect` was run, which is what the
  // person was told. A service inherits none of it — launchd starts in `/`.
  it('is in the unit', () => {
    // Unquoted: systemd takes the rest of the line as the value here, and rejects a quoted one.
    expect(unitFor(spec())).toContain('WorkingDirectory=/Users/mina/work/payments\n')
  })

  it('is in the plist', () => {
    expect(plistFor(spec())).toContain(
      '<key>WorkingDirectory</key>\n    <string>/Users/mina/work/payments</string>',
    )
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

describe('which service manager it hands itself to', () => {
  it('is the machine one when somebody used sudo', () => {
    // `sudo handover connect` is somebody saying "this machine, for everyone". Read as a user
    // service it writes one owned by root's own login session, which on a server begins never.
    expect(forEveryone({}, 0)).toBe(true)
  })

  it('is that person s own when they did not', () => {
    expect(forEveryone({}, 501)).toBe(false)
  })

  it('takes either flag over what it would have guessed', () => {
    expect(forEveryone({ system: true }, 501)).toBe(true)
    expect(forEveryone({ user: true }, 0)).toBe(false)
  })

  it('gives the narrower one to somebody who asked for both', () => {
    // Asking for both is asking for two different things. The one that cannot be arrived at by
    // accident wins.
    expect(forEveryone({ system: true, user: true }, 0)).toBe(false)
  })
})

describe('where it goes and what runs', () => {
  it('is a login agent on a Mac somebody is using', () => {
    const handover = handoverFor(spec({ system: false }), 'darwin', '/Users/mina')

    expect(handover.path).toBe('/Users/mina/Library/LaunchAgents/dev.handover.machine.plist')
    expect(handover.steps.map((step) => step.run.slice(0, 2))).toEqual([
      ['launchctl', 'bootout'],
      ['launchctl', 'print'],
      ['launchctl', 'bootstrap'],
    ])
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
    expect(handover.steps.map((step) => step.run)).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'handover'],
      ['systemctl', '--user', 'restart', 'handover'],
    ])
  })

  it('is the machine service manager on a Linux server', () => {
    const handover = handoverFor(spec({ system: true }), 'linux', '/home/mina')

    expect(handover.path).toBe('/etc/systemd/system/handover.service')
    expect(handover.steps.map((step) => step.run)).toEqual([
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', 'handover'],
      // Restart, not `enable --now`: a running service would otherwise stay on the old PATH, the
      // old directory and the old command, and running `connect` again would look like nothing.
      ['systemctl', 'restart', 'handover'],
    ])
  })

  it('makes room for itself before taking the name, and waits for the name to be free', () => {
    // Running `connect` twice is ordinary, and each step has to say what it does then. Unloading
    // nothing fails, so that one may. `bootout` returns before launchd lets the name go, so the
    // one after it waits for the name to stop answering rather than racing the throttle window.
    const handover = handoverFor(spec(), 'darwin', '/Users/mina')

    expect(handover.steps.map((step) => step.need)).toEqual(['clear-it', 'wait-out', 'do-it'])
    // The name is one launchd will answer about — the session this program is in, not a guess.
    expect(handover.steps[1]?.run.at(-1)).toBe(
      `gui/${String(process.getuid?.())}/dev.handover.machine`,
    )
  })

  it('carries the file with it, so nothing has to guess what was written', () => {
    expect(handoverFor(spec(), 'linux', '/home/mina').contents).toContain('ExecStart=')
  })
})
