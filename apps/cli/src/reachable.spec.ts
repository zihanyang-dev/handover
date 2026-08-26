/**
 * Making `handover` a command the agent can run.
 *
 * The failure this exists to prevent is quiet: an agent told to run something that is not there
 * carries on working for ever, because the one thing it was given to say "I am finished" with
 * does not exist.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { reachableAs } from './reachable.ts'

const run = promisify(execFile)

async function somewhere(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'handover-reachable-')), 'machine.json')
}

describe('putting handover where an agent can reach it', () => {
  it('puts it on the front of the PATH, so a `handover` elsewhere does not win', async () => {
    const beside = await somewhere()

    const path = await reachableAs({ beside, howToRun: '/bin/echo ran' }, { PATH: '/usr/bin' })

    expect(path.split(delimiter)[0]).toContain('bin')
    expect(path.endsWith(`${delimiter}/usr/bin`)).toBe(true)
  })

  it('writes something that actually runs, and passes the words on', async () => {
    // The whole point. A shim that exists and does not work is worse than no shim at all: the
    // agent stops looking.
    const beside = await somewhere()
    const path = await reachableAs({ beside, howToRun: '/bin/echo ran' }, {})

    const bin = path.split(delimiter)[0] ?? ''
    const said = await run(join(bin, 'handover'), ['task', 'done', 'it worked'])

    expect(said.stdout.trim()).toBe('ran task done it worked')
  })

  it('quotes nothing itself — whoever says how to run this has already done that', async () => {
    const beside = await somewhere()
    const path = await reachableAs({ beside, howToRun: "'/opt/my tools/handover'" }, {})

    const wrote = await readFile(join(path.split(delimiter)[0] ?? '', 'handover'), 'utf8')

    expect(wrote).toContain(`exec '/opt/my tools/handover' "$@"`)
  })

  it('leaves the PATH alone rather than failing, when it cannot write', async () => {
    // A machine it cannot write on is a strange one, not a broken one. Refusing to start over it
    // would be a machine that answers nothing at all.
    //
    // Something in the way, rather than a directory with the write bit off: run as root the bit
    // means nothing, and this would quietly become a test that writes the shim after all. A file
    // where a directory has to go stops everybody, root included.
    const inTheWay = join(await mkdtemp(join(tmpdir(), 'handover-blocked-')), 'nowhere')
    await writeFile(inTheWay, '')

    const path = await reachableAs(
      { beside: join(inTheWay, 'machine.json'), howToRun: 'handover' },
      { PATH: '/usr/bin' },
    )

    expect(path).toBe('/usr/bin')
  })
})
