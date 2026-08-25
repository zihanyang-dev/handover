import { describe, expect, it } from 'vitest'
import { agentsFound, AGENT_KIND_NAMES, AGENT_KINDS } from './agent-kind.ts'

describe('the agents this deployment can find', () => {
  it('finds each kind by the command it is actually installed as', () => {
    expect(agentsFound([{ command: 'claude', version: '2.1.4' }])).toEqual([
      { kind: 'claude-code', version: '2.1.4' },
    ])
  })

  it('drops a command it does not know, so a newer CLI cannot break a connection', () => {
    const reported = [
      { command: 'claude', version: '2.1.4' },
      { command: 'some-agent-from-next-year', version: '1.0.0' },
    ]

    expect(agentsFound(reported)).toEqual([{ kind: 'claude-code', version: '2.1.4' }])
  })

  it('keeps nothing when a machine found nothing, which is a machine with something to fix', () => {
    expect(agentsFound([])).toEqual([])
  })

  it('gives every kind its own command, so one binary cannot answer as two agents', () => {
    const commands = AGENT_KIND_NAMES.map((kind) => AGENT_KINDS[kind].command)

    expect(new Set(commands).size).toBe(commands.length)
  })
})
