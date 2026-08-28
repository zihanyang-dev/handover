import { describe, expect, it } from 'vitest'
import { avatarPath } from './avatar.ts'

describe('avatar addresses', () => {
  it('versions both immutable browser paths when their drawing style changes', () => {
    expect(avatarPath({ kind: 'user', userId: 'user-1' })).toMatch(/\?v=/u)
    expect(avatarPath({ kind: 'agent', machineId: 'machine-1', agentKind: 'codex' })).toMatch(
      /\?v=/u,
    )
  })
})
