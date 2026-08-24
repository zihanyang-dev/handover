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

/** What a machine says it found, in its own terms: the command it looked for, and what answered. */
export type Reported = {
  readonly command: string
  readonly version: string
}

/**
 * What a machine reported, as agents this deployment knows.
 *
 * A machine reports by command name because that is what it actually looked for. Names we do not
 * know are dropped rather than refused: a newer CLI against an older server should be a machine
 * with fewer agents, not a machine that cannot check in.
 */
export function agentsFound(reported: readonly Reported[]): readonly FoundAgent[] {
  return reported.flatMap((one) => {
    const kind = AGENT_KIND_NAMES.find((known) => AGENT_KINDS[known].command === one.command)
    return kind === undefined ? [] : [{ kind, version: one.version }]
  })
}
