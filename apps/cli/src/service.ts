/**
 * Handing this machine to whatever keeps things running here.
 *
 * Nothing in here forks, writes a pid file, or decides when to restart. Those are a service
 * manager's job and it is better at all three — a program that does them itself ends up owning a
 * worse copy of one, and then owning the questions that come with it, like which of two log files
 * is the live one.
 *
 * Two kinds, because a laptop and a server want different things and those two wants are exactly
 * what user and system services already mean: a user service starts when somebody logs in and
 * stops when they log out; a system service starts at boot whether anybody is there or not.
 */

export type ServiceSpec = {
  /** Absolute. Never resolved through a shell: a typo in a profile must not stop a service. */
  readonly executable: string
  readonly args: readonly string[]
  readonly system: boolean
  readonly label: string
  /**
   * The PATH to look for agents along, taken from the terminal `connect` was run in.
   *
   * A service inherits almost nothing — launchd hands over four directories and systemd fewer —
   * and looking for agents *is* looking along PATH, so without this a machine that works when run
   * by hand finds nothing at all once it is a service.
   *
   * Taken rather than asked for. Asking a login shell at runtime is what an editor launched from
   * a dock has to do, because it never has a moment when somebody is standing in their own
   * terminal. This does: that moment is `connect`, and its PATH is already the right one.
   *
   * It is a snapshot, and the cost is stated where it is felt: install an agent somewhere new and
   * this will not see it until `handover connect` is run again. That is something a person can
   * actually do, unlike rearranging the files their shell reads.
   */
  readonly path: string
}

/**
 * `WantedBy` is what separates the two.
 *
 * `multi-user.target` is reached during boot, with nobody logged in. `default.target` in a user
 * manager is reached when that person's session starts. Lingering would make a user service start
 * at boot too, which is the one thing that would blur them, so it is not enabled here.
 */
export function unitFor(spec: ServiceSpec): string {
  const command = [spec.executable, ...spec.args].join(' ')

  return `[Unit]
Description=Handover machine agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${command}
Environment="PATH=${spec.path}"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=${spec.system ? 'multi-user.target' : 'default.target'}
`
}

/**
 * `RunAtLoad` starts it when the agent is loaded, which for a LaunchAgent is at login.
 *
 * `KeepAlive` only on a bad exit: stopping on purpose should stay stopped, and a machine that was
 * told to leave should not be dragged back by the thing meant to keep it up.
 */
export function plistFor(spec: ServiceSpec): string {
  const args = [spec.executable, ...spec.args]
    .map((one) => `      <string>${one}</string>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${spec.label}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${spec.path}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
  </dict>
</plist>
`
}

/**
 * Where the file goes, and what to run to make it take effect.
 *
 * Both are printed before anything happens. A program that installs a service and does not say
 * where leaves somebody unable to look at it, change it, or turn it off without guessing.
 */
export type Handover = {
  readonly path: string
  readonly steps: readonly (readonly string[])[]
  readonly contents: string
}

export function handoverFor(spec: ServiceSpec, platform: NodeJS.Platform, home: string): Handover {
  if (platform === 'darwin') return toLaunchd(spec, home)
  return toSystemd(spec, home)
}

function toLaunchd(spec: ServiceSpec, home: string): Handover {
  const path = spec.system
    ? `/Library/LaunchDaemons/${spec.label}.plist`
    : `${home}/Library/LaunchAgents/${spec.label}.plist`

  // `bootstrap` rather than the older `load`: it names the domain, so there is no question about
  // which session a service went into. Falling back to uid 0 would name root's session, which is
  // not a safer guess than none — it is a different machine's worth of wrong.
  const domain = spec.system ? 'system' : `gui/${String(uid())}`

  return {
    path,
    contents: plistFor(spec),
    steps: [['launchctl', 'bootstrap', domain, path]],
  }
}

function toSystemd(spec: ServiceSpec, home: string): Handover {
  const path = spec.system
    ? '/etc/systemd/system/handover.service'
    : `${home}/.config/systemd/user/handover.service`

  // `--user` is not a flavour of the same thing: it is a different manager, owned by the person
  // rather than the machine, which is exactly the difference between a laptop and a server.
  const scope = spec.system ? [] : ['--user']

  return {
    path,
    contents: unitFor(spec),
    steps: [
      ['systemctl', ...scope, 'daemon-reload'],
      ['systemctl', ...scope, 'enable', '--now', 'handover'],
    ],
  }
}

/** Only ever absent on Windows, which has neither of the two service managers this supports. */
function uid(): number {
  if (process.getuid === undefined) throw new Error('no user id here; only macOS and Linux')
  return process.getuid()
}
