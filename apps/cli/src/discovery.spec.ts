import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { findAgents } from './discovery.ts'

/** Real commands on a real PATH: the thing under test is finding them, so nothing is faked. */
let BIN = ''
let ENV: NodeJS.ProcessEnv = {}

async function pretendAgent(name: string, prints: string): Promise<void> {
  const path = join(BIN, name)
  await writeFile(path, `#!/bin/sh\n${prints}\n`)
  await chmod(path, 0o755)
}

// Nothing is torn down: the directory is in the system temp base and holds four shell scripts.
beforeAll(async () => {
  BIN = await mkdtemp(join(tmpdir(), 'handover-agents-'))
  ENV = { PATH: BIN }

  await pretendAgent('speaks-plainly', 'echo 2.1.4')
  await pretendAgent('speaks-around-it', 'echo "codex-cli 0.9.0 (build 7)"')
  await pretendAgent('says-nothing-useful', 'echo hello')
  await pretendAgent('refuses', 'exit 1')
})

describe('finding what is on this machine', () => {
  it('finds one that prints a bare version', async () => {
    expect(await findAgents(['speaks-plainly'], ENV)).toEqual([
      { command: 'speaks-plainly', version: '2.1.4' },
    ])
  })

  it('finds the version inside whatever else it prints', async () => {
    // Every one of these prints its own banner. Taking the number and leaving the rest is what
    // lets a new agent be added without learning its output format first.
    expect(await findAgents(['speaks-around-it'], ENV)).toEqual([
      { command: 'speaks-around-it', version: '0.9.0' },
    ])
  })

  it('does not find one that refuses to run', async () => {
    expect(await findAgents(['refuses'], ENV)).toEqual([])
  })

  it('does not find one that answers without a version', async () => {
    // Reporting it with no version would put a row on somebody's screen that says nothing, and
    // the machine cannot tell whether it would even work.
    expect(await findAgents(['says-nothing-useful'], ENV)).toEqual([])
  })

  it('keeps looking after one of them fails', async () => {
    const found = await findAgents(['refuses', 'speaks-plainly', 'not-here-at-all'], ENV)

    expect(found).toEqual([{ command: 'speaks-plainly', version: '2.1.4' }])
  })

  it('finds nothing on a machine with nothing, rather than failing', async () => {
    // A connected machine with no agents is a machine with something to fix, not a broken one.
    expect(await findAgents(['not-here-at-all'], ENV)).toEqual([])
  })

  it('looks on the PATH it is given, not the one this process happens to have', async () => {
    // Under a service manager the PATH is a short one. Passing it in is what makes that
    // difference visible instead of silently changing the answer.
    expect(await findAgents(['speaks-plainly'], { PATH: '/nonexistent' })).toEqual([])
  })
})
