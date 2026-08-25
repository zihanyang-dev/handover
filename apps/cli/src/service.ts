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
  /**
   * Where the agent works: the directory `handover connect` was run in.
   *
   * A service inherits none of it — launchd starts in `/`, systemd in the unit's own default — so
   * without this the agent reads and writes somewhere nobody chose, under whatever account the
   * service runs as. The whole of "it works in your project" is this one line.
   */
  readonly where: string
}

/**
 * One word of a systemd command line.
 *
 * Quoted, always. A unit file is split on whitespace, and the two paths in here are somebody's
 * home directory and wherever they installed this — `/Users/mina/My Tools/node` is an ordinary
 * thing for either to be, and unquoted it is a service that starts a program called `/Users/mina/My`.
 *
 * `%` is doubled because systemd reads it as the start of a specifier, and a directory with one in
 * it would be silently replaced by something else entirely.
 */
function quoted(word: string): string {
  return `"${escaped(word)}"`
}

/** The three characters systemd reads rather than passes on. */
function escaped(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
}

/**
 * A path in a setting that takes one, rather than a command line.
 *
 * Unquoted, because systemd reads the rest of the line as the value here and rejects the unit if
 * it is quoted — measured against a real systemd, which is also why this is not the same helper
 * the command line uses. Only `%` has to go, since it would start a specifier.
 */
function asPath(value: string): string {
  return value.replaceAll('%', '%%')
}

/**
 * `WantedBy` is what separates the two.
 *
 * `multi-user.target` is reached during boot, with nobody logged in. `default.target` in a user
 * manager is reached when that person's session starts. Lingering would make a user service start
 * at boot too, which is the one thing that would blur them, so it is not enabled here.
 */
export function unitFor(spec: ServiceSpec): string {
  const command = [spec.executable, ...spec.args].map(quoted).join(' ')

  return `[Unit]
Description=Handover machine agent
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${asPath(spec.where)}
ExecStart=${command}
Environment="PATH=${escaped(spec.path)}"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=${spec.system ? 'multi-user.target' : 'default.target'}
`
}

/**
 * A value inside a plist, which is XML and reads three characters rather than passing them on.
 *
 * A path with an `&` in it is a plist launchd will not parse at all — and the whole file is
 * refused, so the machine simply never comes back after a reboot with nothing to say why.
 */
function inXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * `RunAtLoad` starts it when the agent is loaded, which for a LaunchAgent is at login.
 *
 * `KeepAlive` only on a bad exit: stopping on purpose should stay stopped, and a machine that was
 * told to leave should not be dragged back by the thing meant to keep it up.
 */
export function plistFor(spec: ServiceSpec): string {
  const args = [spec.executable, ...spec.args]
    .map((one) => `      <string>${inXml(one)}</string>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${inXml(spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>WorkingDirectory</key>
    <string>${inXml(spec.where)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${inXml(spec.path)}</string>
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
  readonly steps: readonly Step[]
  readonly contents: string
}

export type Step = {
  /** A program and its arguments. Non-empty by construction: a step with nothing to run is not one. */
  readonly run: readonly [string, ...string[]]
  readonly need: Need
}

/**
 * Running `connect` twice is an ordinary thing — a new key, a moved repository, a second look —
 * so every step here has to say what it does when the machine is already connected.
 *
 * ```
 * do-it     the work. Failing here is the command failing.
 * clear-it  clears the way. There being nothing to clear is the ordinary case.
 * wait-out  run until it fails. That failure is what is being waited for.
 * ```
 */
export type Need = 'do-it' | 'clear-it' | 'wait-out'

/**
 * Which service manager this machine hands itself to.
 *
 * Taken from who is running rather than from a flag nobody passes. `sudo handover connect` is
 * somebody saying "this machine, for everyone", and read as a user service it writes one owned by
 * root's own login session — which on a server begins never. Either flag says it out loud when the
 * default is not what was wanted; asking for both is asking for two different things, and the
 * narrower one wins because it is the one that cannot be arrived at by accident.
 */
export function forEveryone(asked: { system?: boolean; user?: boolean }, uid: number): boolean {
  if (asked.user === true) return false
  if (asked.system === true) return true

  return uid === 0
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
  const service = `${domain}/${spec.label}`

  return {
    path,
    contents: plistFor(spec),
    steps: [
      { run: ['launchctl', 'bootout', service], need: 'clear-it' },
      // `bootout` returns before launchd lets the name go: it keeps the job for the whole
      // ThrottleInterval, so a `bootstrap` right behind it lands in a five-second window where
      // the name is still taken and fails with an error that says only "Input/output error".
      // Waiting for the old one to actually be gone is the precondition, so it is written as one
      // rather than as a retry that would hide what is being waited for.
      { run: ['launchctl', 'print', service], need: 'wait-out' },
      { run: ['launchctl', 'bootstrap', domain, path], need: 'do-it' },
    ],
  }
}

function toSystemd(spec: ServiceSpec, home: string): Handover {
  const path = spec.system
    ? '/etc/systemd/system/handover.service'
    : `${home}/.config/systemd/user/handover.service`

  // `--user` is not a flavour of the same thing: it is a different manager, owned by the person
  // rather than the machine, which is exactly the difference between a laptop and a server.
  const systemctl = spec.system ? (['systemctl'] as const) : (['systemctl', '--user'] as const)

  return {
    path,
    contents: unitFor(spec),
    // All three are repeatable: reloading is always safe, enabling something enabled does nothing,
    // and restarting starts one that is not running. Nothing here needs clearing or waiting for.
    steps: [
      { run: [...systemctl, 'daemon-reload'], need: 'do-it' },
      { run: [...systemctl, 'enable', 'handover'], need: 'do-it' },
      // Restart, not `enable --now`: `--now` starts a stopped service and leaves a running one
      // exactly as it was — still on the old PATH, the old directory and the old command. Running
      // `connect` again is somebody saying those changed, and a service that ignores them looks
      // like a command that did nothing.
      { run: [...systemctl, 'restart', 'handover'], need: 'do-it' },
    ],
  }
}

/** Only ever absent on Windows, which has neither of the two service managers this supports. */
function uid(): number {
  if (process.getuid === undefined) throw new Error('no user id here; only macOS and Linux')
  return process.getuid()
}
