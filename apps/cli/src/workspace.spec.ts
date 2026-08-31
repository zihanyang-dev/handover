import { mkdtemp, readdir, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { prepareWorkspace, whereToWork } from './workspace.ts'

const root = await mkdtemp(join(tmpdir(), 'handover-workspace-'))

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const ITS_OWN = { kind: 'its-own' } as const
const plain = { conversationId: 'c-1', where: ITS_OWN, hasRunBefore: false }

describe('where a turn works', () => {
  it('is a folder of its own, named after the conversation', () => {
    expect(whereToWork(ITS_OWN, 'c-1', root)).toBe(join(root, 'c-1'))
  })

  it('is under the work it belongs to when it is a sub-task', () => {
    // One level down, so it reads what its parent has been writing without anything being passed.
    expect(whereToWork({ kind: 'under', conversationId: 'c-1' }, 'c-2', root)).toBe(
      join(root, 'c-1', 'subtask', 'c-2'),
    )
  })
})

describe('getting it ready', () => {
  it('makes the folder, and a first turn has not started over', async () => {
    expect(await prepareWorkspace(plain, root)).toEqual({
      kind: 'ready',
      path: join(root, 'c-1'),
      startedOver: false,
    })
  })

  it('has not started over when the folder is already there', async () => {
    await prepareWorkspace({ ...plain, hasRunBefore: true }, root)

    expect(await prepareWorkspace({ ...plain, hasRunBefore: true }, root)).toMatchObject({
      startedOver: false,
    })
  })

  it('has started over when it makes again what a turn had already worked in', async () => {
    // Both halves, and neither alone: making a folder is ordinary on a first turn, and a
    // conversation that has run before is ordinary every time nobody deleted anything.
    await prepareWorkspace(plain, root)
    await rmdir(join(root, 'c-1'))

    expect(await prepareWorkspace({ ...plain, hasRunBefore: true }, root)).toMatchObject({
      startedOver: true,
    })
  })

  it('makes every level of a sub-task at once', async () => {
    const deep = {
      conversationId: 'c-2',
      where: { kind: 'under', conversationId: 'c-9' },
      hasRunBefore: false,
    } as const

    await prepareWorkspace(deep, root)

    expect(await readdir(join(root, 'c-9', 'subtask'))).toEqual(['c-2'])
  })
})
