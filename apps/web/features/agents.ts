/**
 * How an agent's name is spelled to a person.
 *
 * The list of agents belongs to the server; how each is written on a screen belongs here, the same
 * split as providers. `Record<Kind, …>` is taken from the contract, so an agent added over there
 * is a compile error here until somebody names it, rather than an identifier shown to a person.
 *
 * The lookup still takes a plain string: a conversation names the agent it was opened with, which
 * may be one this build has never heard of. That one is shown as itself rather than hidden.
 */

import type { components } from '../generated/api.ts'

/** The agents this deployment offers, as the contract lists them. */
export type AgentKind = components['schemas']['MachineAgent']['kind']

const NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
} satisfies Record<AgentKind, string>

export function agentName(kind: string): string {
  return NAMES[kind] ?? kind
}
