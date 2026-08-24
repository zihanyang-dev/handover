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
  // which session a service went into.
  const domain = spec.system ? 'system' : `gui/${String(process.getuid?.() ?? 0)}`

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
