/**
 * The agents this deployment knows how to find on a machine.
 *
 * A fixed list, not a plugin protocol and not something an agent registers itself as. Finding one
 * means looking for its command on the machine's PATH, so the whole of "discovery" is this table
 * plus a lookup — and adding an agent is a line here, a line in the migration, and nothing else.
 *
 * A command and nothing more. What an agent is called on a screen is the page's, next to how every
 * other name is spelled to a person; a copy kept here would be one nothing ever read.
 */

export const AGENT_KINDS = {
  'claude-code': { command: 'claude' },
  codex: { command: 'codex' },
} as const satisfies Record<string, { readonly command: string }>

export type AgentKind = keyof typeof AGENT_KINDS

export const AGENT_KIND_NAMES = Object.keys(AGENT_KINDS) as readonly AgentKind[]

/**
 * The commands a machine should look for.
 *
 * Told to machines rather than compiled into them: this deployment decides what it knows how to
 * run, so adding an agent here is every machine looking for it on its next check-in, with nothing
 * to install and nothing to upgrade.
 */
export const AGENT_COMMANDS = AGENT_KIND_NAMES.map((kind) => AGENT_KINDS[kind].command)

/**
 * One thing an agent lets a person choose for a single question.
 *
 * Ours, not the agent's: each adapter turns whatever its own SDK says into this, so a page has one
 * shape to render whichever agent it is looking at. Carried through and stored as it arrives.
 */
export type Model = {
  readonly id: string
  readonly name: string
  readonly about: string
  /** How hard this particular model may be asked to think. Empty when it has no such setting. */
  readonly efforts: readonly string[]
  /** What it uses when nobody says. Absent when the agent does not name one. */
  readonly defaultEffort?: string | undefined
  /** The one a person gets by saying nothing. Exactly one model in a list carries this. */
  readonly isDefault: boolean
}

/** What a machine found: which kind, which version answered, and what that version offers. */
export type FoundAgent = {
  readonly kind: AgentKind
  readonly version: string
  /**
   * Absent when this report says nothing about it, which is not the same as an empty list.
   *
   * A machine asks its agent only when the version it found is new, because asking costs starting
   * the agent up. Every other report simply does not mention models, and what was stored stands.
   */
  readonly models?: readonly Model[]
}

/**
 * An agent on a machine, as the database has it.
 *
 * `models` comes back as whatever is in the column. It is left unread here on purpose: a list
 * written by a different build of this program is exactly the case where a shape can be wrong, and
 * the layer that has to answer for it is the one putting it on the wire.
 */
export type Installed = {
  readonly kind: AgentKind
  readonly version: string
  readonly models: unknown
}

/** What a machine says it found, in its own terms: the command it looked for, and what answered. */
export type Reported = {
  readonly command: string
  readonly version: string
  readonly models?: readonly Model[] | undefined
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
    if (kind === undefined) return []

    return [
      { kind, version: one.version, ...(one.models === undefined ? {} : { models: one.models }) },
    ]
  })
}
