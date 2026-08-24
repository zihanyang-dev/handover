/**
 * The agents this deployment knows how to find on a machine.
 *
 * A fixed list, not a plugin protocol and not something an agent registers itself as. Finding one
 * means looking for its command on the machine's PATH, so the whole of "discovery" is this table
 * plus a lookup — and adding an agent is a line here, a line in the migration, and nothing else.
 */

export const AGENT_KINDS = {
  'claude-code': { command: 'claude', label: 'Claude Code' },
  codex: { command: 'codex', label: 'Codex' },
  'cursor-agent': { command: 'cursor-agent', label: 'Cursor Agent' },
} as const satisfies Record<string, { readonly command: string; readonly label: string }>

export type AgentKind = keyof typeof AGENT_KINDS

export const AGENT_KIND_NAMES = Object.keys(AGENT_KINDS) as readonly AgentKind[]

/** What a machine found: which kind, and which version of it answered. */
export type FoundAgent = {
  readonly kind: AgentKind
  readonly version: string
}

/**
 * The kind a command name belongs to, if this deployment knows it.
 *
 * A machine reports what it found by command name, because that is what it actually looked for.
 * Names it reports that we do not know are dropped rather than refused: a newer CLI on an older
 * server is a machine that keeps working with fewer agents, not a machine that cannot connect.
 */
export function kindOfCommand(command: string): AgentKind | undefined {
  return AGENT_KIND_NAMES.find((kind) => AGENT_KINDS[kind].command === command)
}
