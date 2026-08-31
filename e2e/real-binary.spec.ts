/**
 * The seam neither other suite reaches: the compiled binary, driven from a browser.
 *
 * `journey.spec.ts` makes everything real except the agent process; `agent-check` makes the agents
 * real but has no browser. What sits between them — the single-file executable somebody actually
 * downloads — is tested by neither, and it is where `v0.1.0` broke in three places at once: a Bun
 * build reports `argv[1]` as `/$bunfs/root/…`, which went into the service file and into the shim
 * an agent calls, so nothing started and every `handover task` failed.
 *
 * The service manager is the one thing held back. `connect` installs `dev.handover.machine`, and
 * this machine already runs one against production; so `connect` is given a HOME of its own and
 * writes its plist into that, while `run` is given the real one, because that is where the agents
 * keep their credentials.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { machineEnvironment } from '../apps/cli/src/env.ts'
import { connects, makesASpace, signsIn } from './someone.ts'

const run = promisify(execFile)
const CLI = join(import.meta.dirname, '..', 'apps', 'cli')
/** Built here rather than taken from a release, so what runs is this checkout. */
const BINARY = join(CLI, 'dist-host', 'handover')
const ORIGIN = 'http://localhost:3199'

const db = connects()
let machine: ChildProcess | undefined

test.beforeAll(async () => {
  // One target, this host's. `pnpm --filter @handover/cli build` makes all four, which is a
  // release's job and takes long enough that somebody would stop running this.
  await run(join(CLI, 'node_modules', '.bin', 'bun'), [
    'build',
    join(CLI, 'src', 'main.ts'),
    '--compile',
    `--target=bun-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
    '--outfile',
    BINARY,
  ])
})

test.afterAll(async () => {
  machine?.kill('SIGTERM')
  await db.destroy()
})

test('the compiled binary connects, and a real agent answers into the browser', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000)

  await signsIn(page, 'zane')
  await makesASpace(page)

  const cookie = (await context.cookies()).find((one) => one.name === 'handover_session')
  expect(cookie, 'signed in').toBeDefined()

  const answered = await fetch(`${ORIGIN}/me/machine-keys`, {
    method: 'POST',
    headers: {
      cookie: `handover_session=${cookie?.value ?? ''}`,
      'content-type': 'application/json',
    },
    body: '{}',
  })
  const { key } = (await answered.json()) as { key: string }
  expect(key).toMatch(/^hk_/u)

  // Its own HOME, so the service it installs is not the one this laptop already runs.
  const alone = await mkdtemp(join(tmpdir(), 'handover-real-'))
  const config = join(alone, '.config')
  await run(BINARY, ['connect', '--origin', ORIGIN, '--key', key], {
    env: { ...machineEnvironment(), HOME: alone, XDG_CONFIG_HOME: config },
  }).catch(() => undefined)

  const attached = JSON.parse(await readFile(join(config, 'handover', 'machine.json'), 'utf8')) as {
    readonly origin: string
    readonly machineId: string
  }
  expect(attached.origin, 'the binary wrote where it attached').toBe(ORIGIN)
  expect(attached.machineId, 'and which machine it became').toBeTruthy()

  // The real HOME from here: this is the half that runs an agent, and the agents are signed in
  // there rather than in a directory made a moment ago.
  machine = spawn(BINARY, ['run'], {
    env: { ...machineEnvironment(), XDG_CONFIG_HOME: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  await page.getByRole('tab', { name: 'Chat' }).click()
  const agent = page.getByRole('link', { name: /Claude Code on .*, ready/u }).first()
  await expect(agent, 'the binary reported the agents it found').toBeVisible({ timeout: 90_000 })
  await agent.click()

  await page.getByLabel(/^Message /u).fill('reply with exactly: pineapple')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page).toHaveURL(/\/c\//u)

  await expect(page.getByText(/pineapple/iu).first()).toBeVisible({ timeout: 180_000 })
})
