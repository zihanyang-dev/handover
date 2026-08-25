/**
 * The unit, judged by systemd itself.
 *
 * Everything else about this CLI is tested against fakes; a service manager cannot be faked
 * usefully, because what is being claimed is exactly that the real one accepts the file, starts
 * the process, and brings it back when it dies. So a real one runs, in a container.
 *
 * macOS has no equivalent: there is no container that runs launchd. That half is checked by
 * `plutil` for shape and by a person for the rest, and it is the one place in this repository
 * where "somebody ran it once" is the whole of the evidence.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handoverFor, unitFor, type ServiceSpec } from '../src/service.ts'

const run = promisify(execFile)

const IMAGE = 'handover-service-check'
/** A directory the container really has, so what the service starts in can be read back. */
const WHERE = '/home/mina/work'

const CONTAINER = `handover-service-check-${randomUUID().slice(0, 8)}`

const STUB = '/usr/local/bin/handover-stub'

/** Where the stub lives, so a unit that carries a PATH carries one that can find it. */
const PATH = '/usr/local/bin:/usr/bin:/bin'

async function inside(script: string): Promise<string> {
  const { stdout } = await run('docker', ['exec', CONTAINER, 'sh', '-c', script])
  return stdout.trim()
}

/** systemd takes a moment to reach a usable state, and nothing here is worth asserting before it. */
async function waitForInit(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await inside('systemctl is-system-running || true')
    if (state === 'running' || state === 'degraded') return
    await new Promise((wake) => setTimeout(wake, 500))
  }
  throw new Error('systemd did not come up in the container')
}

beforeAll(async () => {
  await run('docker', ['build', '--quiet', '--tag', IMAGE, import.meta.dirname])
  await run('docker', [
    'run',
    '--rm',
    '--detach',
    '--privileged',
    '--cgroupns=host',
    '--volume',
    '/sys/fs/cgroup:/sys/fs/cgroup:rw',
    '--name',
    CONTAINER,
    IMAGE,
  ])
  await waitForInit()
  // The directory `connect` was run in. Made once, up front, because every unit in this file now
  // names it — a service whose working directory is missing does not start at all.
  await inside(`mkdir -p ${WHERE}`)
}, 600_000)

afterAll(async () => {
  await run('docker', ['rm', '--force', CONTAINER])
})

function spec(system: boolean): ServiceSpec {
  return {
    executable: STUB,
    args: [],
    system,
    label: 'dev.handover.machine',
    path: PATH,
    where: WHERE,
  }
}

/** The file the CLI would write, in the place it would write it, with the steps it would run. */
async function install(system: boolean): Promise<void> {
  const unit = unitFor(spec(system))
  const where = system
    ? '/etc/systemd/system/handover.service'
    : '/home/mina/.config/systemd/user/handover.service'

  await inside(`mkdir -p $(dirname ${where}) && cat > ${where} <<'UNIT'\n${unit}UNIT`)

  if (system) {
    // The steps the CLI would run, in the order it would run them.
    for (const step of handoverFor(spec(true), 'linux', '/home/mina').steps) {
      await inside(step.run.join(' '))
    }
    return
  }

  await inside('chown -R mina:mina /home/mina/.config && loginctl enable-linger mina')
  const steps = handoverFor(spec(false), 'linux', '/home/mina')
    .steps.map((step) => step.run.join(' '))
    .join(' && ')
  await inside(`su - mina -c 'export XDG_RUNTIME_DIR=/run/user/$(id -u); ${steps}'`)
}

describe('the unit we generate', () => {
  it('is one systemd itself accepts, including the command it points at', async () => {
    // Catches the mistake with the worst symptoms: an ExecStart that does not exist, which would
    // otherwise show up as a machine that silently never comes online.
    const unit = unitFor(spec(true))
    await inside(`mkdir -p /check && cat > /check/handover.service <<'UNIT'\n${unit}UNIT`)

    const complaints = await inside('systemd-analyze verify /check/handover.service 2>&1 || true')

    expect(complaints).toBe('')
  })

  it('is refused when the command it points at is not there', async () => {
    // The check above is only worth having if it can fail. This is that.
    const unit = unitFor({ ...spec(true), executable: '/usr/local/bin/not-installed' })
    await inside(`cat > /check/missing.service <<'UNIT'\n${unit}UNIT`)

    const complaints = await inside('systemd-analyze verify /check/missing.service 2>&1 || true')

    expect(complaints).toContain('not executable')
  })
})

describe('the two ways of stopping, which the unit has to tell apart', () => {
  async function startOne(name: string, executable: string): Promise<void> {
    const unit = unitFor({ ...spec(true), executable })
    await inside(`cat > /etc/systemd/system/${name}.service <<'UNIT'\n${unit}UNIT`)
    await inside(`systemctl daemon-reload && systemctl start ${name} || true`)
  }

  it('leaves a service that finished alone, which is what being taken out of a Space is', async () => {
    // The CLI exits zero when its machine was removed, and this is the half of that decision that
    // lives in the unit. Read as a failure it would come back every RestartSec forever, to be
    // told the same thing by a server that no longer has a credential for it.
    await startOne('handover-left', '/usr/local/bin/handover-left')
    await new Promise((wake) => setTimeout(wake, 8000))

    expect(await inside('systemctl is-active handover-left || true')).toBe('inactive')
    expect(await inside('systemctl show -p NRestarts --value handover-left')).toBe('0')
  }, 60_000)

  it('brings back one that failed, because that is what a bad exit is for', async () => {
    // The check above is only worth having if the unit can tell the two apart. This is that.
    await startOne('handover-broke', '/usr/local/bin/handover-broke')
    await new Promise((wake) => setTimeout(wake, 8000))

    expect(
      Number(await inside('systemctl show -p NRestarts --value handover-broke')),
    ).toBeGreaterThan(0)
  }, 60_000)
})

describe('handing a system service over', () => {
  beforeAll(async () => {
    await install(true)
  }, 120_000)

  it('is running, and set to run again at boot', async () => {
    expect(await inside('systemctl is-active handover')).toBe('active')
    expect(await inside('systemctl is-enabled handover')).toBe('enabled')
  })

  it('comes back when the process dies, which is the whole reason to hand it over', async () => {
    await inside('kill -9 $(systemctl show -p MainPID --value handover)')

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await inside('systemctl is-active handover || true')) === 'active') break
      await new Promise((wake) => setTimeout(wake, 500))
    }

    expect(await inside('systemctl is-active handover')).toBe('active')
    expect(Number(await inside('systemctl show -p NRestarts --value handover'))).toBeGreaterThan(0)
  }, 60_000)

  it('runs in the directory connect was run in, which is where the agent works', async () => {
    // The whole of "it works in your project". A service inherits none of it: without the unit
    // saying so, systemd starts it in `/` and the agent reads and writes there instead.
    const pid = await inside('systemctl show -p MainPID --value handover')

    expect(await inside(`readlink /proc/${pid}/cwd`)).toBe(WHERE)
  })

  it('does not start at all when that directory is gone, rather than running somewhere else', async () => {
    // Failing loudly is the point: a service quietly running in `/` would read and write files
    // nobody chose, under whatever account it runs as.
    const unit = unitFor({ ...spec(true), where: '/home/mina/no-such-project' })
    await inside(`cat > /etc/systemd/system/handover-nowhere.service <<'UNIT'\n${unit}UNIT`)
    await inside('systemctl daemon-reload && systemctl start handover-nowhere || true')

    expect(await inside('systemctl is-active handover-nowhere || true')).not.toBe('active')
  }, 60_000)

  it('puts its output where the system keeps output, not in a directory of our own', async () => {
    expect(await inside('journalctl -u handover --no-pager -n 1 -q || true')).not.toBe('')
  })

  it('survives being handed over a second time, which is what running connect twice is', async () => {
    // The macOS side needs a step to make room for itself here. This says the Linux side does
    // not — and says it by running the same steps again rather than by reading them.
    await install(true)

    expect(await inside('systemctl is-active handover')).toBe('active')
  }, 120_000)

  it('really replaces the process, so a second connect is not a command that did nothing', async () => {
    // `enable --now` starts a stopped service and leaves a running one exactly as it was — still
    // on the old PATH, the old directory and the old command. Somebody running `connect` again is
    // saying those changed.
    const before = await inside('systemctl show -p MainPID --value handover')

    await install(true)

    expect(await inside('systemctl show -p MainPID --value handover')).not.toBe(before)
    expect(await inside('systemctl is-active handover')).toBe('active')
  }, 120_000)
})

describe('handing a user service over', () => {
  beforeAll(async () => {
    await install(false)
  }, 120_000)

  it('is running under that person, without root', async () => {
    const active = await inside(
      `su - mina -c 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-active handover'`,
    )

    expect(active).toBe('active')
  })

  it('survives being handed over a second time too', async () => {
    await install(false)

    const active = await inside(
      `su - mina -c 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-active handover'`,
    )

    expect(active).toBe('active')
  }, 120_000)
})
