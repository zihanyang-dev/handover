import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolvedPath } from './shell-path.ts'

let BIN = ''

async function pretendShell(name: string, body: string): Promise<string> {
  const path = join(BIN, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

let GENEROUS = ''
let SILENT = ''
let BROKEN = ''
let SLOW = ''

beforeAll(async () => {
  BIN = await mkdtemp(join(tmpdir(), 'handover-shell-'))
  GENEROUS = await pretendShell('generous', 'printf %s /opt/homebrew/bin:/usr/bin')
  SILENT = await pretendShell('silent', 'printf %s ""')
  BROKEN = await pretendShell('broken', 'exit 3')
  SLOW = await pretendShell('slow', 'sleep 30')
})

const OURS = { PATH: '/usr/bin:/bin' }

describe('the PATH a terminal would have', () => {
  it('takes what the login shell says', async () => {
    expect(await resolvedPath(OURS, GENEROUS)).toEqual({
      path: '/opt/homebrew/bin:/usr/bin',
      from: 'login-shell',
    })
  })

  it('says which one it used, because "no agents found" reads differently either way', async () => {
    expect((await resolvedPath(OURS, BROKEN)).from).toBe('this-process')
  })

  it('falls back when there is no shell to ask', async () => {
    expect(await resolvedPath(OURS, undefined)).toEqual({
      path: '/usr/bin:/bin',
      from: 'this-process',
    })
  })

  it('falls back when the shell errors in its own profile', async () => {
    expect(await resolvedPath(OURS, BROKEN)).toEqual({
      path: '/usr/bin:/bin',
      from: 'this-process',
    })
  })

  it('falls back when the shell says nothing', async () => {
    expect(await resolvedPath(OURS, SILENT)).toEqual({
      path: '/usr/bin:/bin',
      from: 'this-process',
    })
  })

  it('gives up on a shell that takes too long rather than never checking in', async () => {
    // A heavy profile should cost a machine some places to look, never its ability to report.
    expect(await resolvedPath(OURS, SLOW)).toEqual({ path: '/usr/bin:/bin', from: 'this-process' })
  }, 10_000)
})
