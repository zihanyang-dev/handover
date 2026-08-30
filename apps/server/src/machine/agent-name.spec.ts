import { describe, expect, it } from 'vitest'
import { fallbackAgentName } from './agent-name.ts'

const MACHINE = 'f80a8e1a-e377-4b4e-a89b-9973c691a2e0'

describe('an agent nobody named', () => {
  it('gets a stable name rather than changing whenever somebody reads it', () => {
    const first = fallbackAgentName(MACHINE, 'claude-code')

    expect(first).not.toBe('')
    expect(fallbackAgentName(MACHINE, 'claude-code')).toBe(first)
  })

  it('does not make every agent on one machine look like the same one', () => {
    expect(fallbackAgentName(MACHINE, 'claude-code')).not.toBe(fallbackAgentName(MACHINE, 'codex'))
  })
})
