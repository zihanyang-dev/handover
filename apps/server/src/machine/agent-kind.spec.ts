import { describe, expect, it } from 'vitest'
import { AGENT_KIND_NAMES, AGENT_KINDS, kindOfCommand } from './agent-kind.ts'

describe('the agents this deployment can find', () => {
  it('finds each kind by the command it is actually installed as', () => {
    expect(kindOfCommand('claude')).toBe('claude-code')
    expect(kindOfCommand('codex')).toBe('codex')
  })

  it('drops a command it does not know, so a newer CLI cannot break a connection', () => {
    expect(kindOfCommand('some-agent-from-next-year')).toBeUndefined()
  })

  it('gives every kind its own command, so one binary cannot answer as two agents', () => {
    const commands = AGENT_KIND_NAMES.map((kind) => AGENT_KINDS[kind].command)

    expect(new Set(commands).size).toBe(commands.length)
  })

  it('gives every kind a label, because a screen cannot show an identifier', () => {
    const unlabelled = AGENT_KIND_NAMES.filter((kind) => AGENT_KINDS[kind].label.trim() === '')

    expect(unlabelled).toEqual([])
  })
})
