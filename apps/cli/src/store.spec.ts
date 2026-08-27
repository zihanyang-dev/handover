import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { attachmentPath, readAttachment, writeAttachment } from './store.ts'

let HOME = ''

beforeEach(async () => {
  HOME = await mkdtemp(join(tmpdir(), 'handover-store-'))
})

const ATTACHMENT = {
  origin: 'http://handover.test',
  machineId: 'm-1',
  token: 'hm_token',
  lookFor: ['claude'],
}

describe('reading one back', () => {
  it('is nothing when there is no file, which is a machine nobody has connected', async () => {
    expect(await readAttachment(join(HOME, 'machine.json'))).toBeUndefined()
  })

  it('is nothing when a field this version needs is not in the file', async () => {
    // What an upgrade looks like from here: a file written before `lookFor` existed. Reading it as
    // one would leave a machine looking for nothing and reporting that it has nothing.
    const { lookFor: _lookFor, ...older } = ATTACHMENT
    const path = join(HOME, 'machine.json')
    await writeFile(path, JSON.stringify(older))

    expect(await readAttachment(path)).toBeUndefined()
  })

  it('is nothing when the file was cut off half way', async () => {
    const path = join(HOME, 'machine.json')
    await writeFile(path, JSON.stringify(ATTACHMENT).slice(0, 20))

    expect(await readAttachment(path)).toBeUndefined()
  })
})

describe('where it is kept', () => {
  it('is under the config home when this is somebody running it', () => {
    expect(attachmentPath('/home/mina/.config', false)).toBe(
      '/home/mina/.config/handover/machine.json',
    )
  })

  it('falls back to the conventional place when nothing says otherwise', () => {
    expect(attachmentPath(undefined, false)).toMatch(/\.config\/handover\/machine\.json$/u)
  })

  it('is outside any home directory when it is a system service', () => {
    // A system service runs as root or a service user and cannot read somebody's home. Two
    // locations because they belong to two different things, not because one is a fallback.
    expect(attachmentPath('/home/mina/.config', true)).toBe('/etc/handover/machine.json')
  })
})

describe('keeping it', () => {
  it('reads back exactly what was written', async () => {
    const path = join(HOME, 'machine.json')

    await writeAttachment(path, ATTACHMENT)

    expect(await readAttachment(path)).toEqual(ATTACHMENT)
  })

  it('is readable by nobody else', async () => {
    // It is a credential. A file anyone on the machine can read is a credential anyone on the
    // machine has.
    const path = join(HOME, 'machine.json')

    await writeAttachment(path, ATTACHMENT)

    expect((await stat(path)).mode & 0o077).toBe(0)
  })

  it('narrows a file that was already there with wider permissions', async () => {
    const path = join(HOME, 'machine.json')
    await writeFile(path, '{}', { mode: 0o644 })

    await writeAttachment(path, ATTACHMENT)

    expect((await stat(path)).mode & 0o077).toBe(0)
  })

  it('replaces one that is already there, leaving nothing beside it', async () => {
    const path = join(HOME, 'machine.json')
    await writeAttachment(path, ATTACHMENT)

    await writeAttachment(path, { ...ATTACHMENT, token: 'hm_second' })

    expect(await readAttachment(path)).toMatchObject({ token: 'hm_second' })
    expect(await readdir(HOME)).toEqual(['machine.json'])
  })

  it('leaves the credential that was there untouched when the write fails', async () => {
    // Two successful writes prove nothing: written straight over the top they would both pass,
    // and the failure this guards against is a crash *during* one. The failure is made certain
    // here instead of waited for — something is already sitting where the new file has to go.
    const path = join(HOME, 'machine.json')
    await writeAttachment(path, ATTACHMENT)
    await mkdir(`${path}.new`)

    await expect(writeAttachment(path, { ...ATTACHMENT, token: 'hm_second' })).rejects.toThrow()

    // A machine that was connected still reads as connected, and reads whole.
    expect(await readAttachment(path)).toMatchObject({ token: ATTACHMENT.token })
  })

  it('clears up after itself when it cannot put the new one in place', async () => {
    // The other end of the same write. A `.new` left lying about is a token at rest that nothing
    // will ever use and nothing will ever remove.
    const path = join(HOME, 'taken')
    await mkdir(path)
    await writeFile(join(path, 'occupied'), 'x')

    await expect(writeAttachment(path, ATTACHMENT)).rejects.toThrow()

    expect(await readdir(HOME)).not.toContain('taken.new')
  })

  it('has nothing to read before anything was written', async () => {
    expect(await readAttachment(join(HOME, 'never-written.json'))).toBeUndefined()
  })

  it('has nothing to read when the file is not what it should be', async () => {
    // Half-written by a machine that lost power, or edited by hand. Both mean the same thing to
    // the caller: there is nothing here to be, so ask to come in.
    const path = join(HOME, 'machine.json')
    await writeFile(path, '{ not json')

    expect(await readAttachment(path)).toBeUndefined()
  })
})
