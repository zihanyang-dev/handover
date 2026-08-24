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
import { unitFor } from '../src/service.ts'

const run = promisify(execFile)

const IMAGE = 'handover-service-check'
const CONTAINER = `handover-service-check-${randomUUID().slice(0, 8)}`

const STUB = '/usr/local/bin/handover-stub'

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
}, 600_000)

afterAll(async () => {
  await run('docker', ['rm', '--force', CONTAINER])
})

async function install(system: boolean): Promise<void> {
  const unit = unitFor({ executable: STUB, args: [], system, label: 'dev.handover.machine' })
  const where = system
    ? '/etc/systemd/system/handover.service'
    : '/home/mina/.config/systemd/user/handover.service'

  await inside(`mkdir -p $(dirname ${where}) && cat > ${where} <<'UNIT'\n${unit}UNIT`)

  if (system) {
    await inside('systemctl daemon-reload && systemctl enable --now handover')
    return
  }

  await inside('chown -R mina:mina /home/mina/.config && loginctl enable-linger mina')
  await inside(
    `su - mina -c 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user daemon-reload && systemctl --user enable --now handover'`,
  )
}

describe('the unit we generate', () => {
  it('is one systemd itself accepts, including the command it points at', async () => {
    // Catches the mistake with the worst symptoms: an ExecStart that does not exist, which would
    // otherwise show up as a machine that silently never comes online.
    const unit = unitFor({
      executable: STUB,
      args: [],
      system: true,
      label: 'dev.handover.machine',
    })
    await inside(`mkdir -p /check && cat > /check/handover.service <<'UNIT'\n${unit}UNIT`)

    const complaints = await inside('systemd-analyze verify /check/handover.service 2>&1 || true')

    expect(complaints).toBe('')
  })

  it('is refused when the command it points at is not there', async () => {
    // The check above is only worth having if it can fail. This is that.
    const unit = unitFor({
      executable: '/usr/local/bin/not-installed',
      args: [],
      system: true,
      label: 'dev.handover.machine',
    })
    await inside(`cat > /check/missing.service <<'UNIT'\n${unit}UNIT`)

    const complaints = await inside('systemd-analyze verify /check/missing.service 2>&1 || true')

    expect(complaints).toContain('not executable')
  })
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

  it('puts its output where the system keeps output, not in a directory of our own', async () => {
    expect(await inside('journalctl -u handover --no-pager -n 1 -q || true')).not.toBe('')
  })
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
})
