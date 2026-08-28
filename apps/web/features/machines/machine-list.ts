/**
 * The machines one Space can reach, and the agents on them.
 *
 * Both shapes live here because both are read by more than one screen — the sidebar lists every
 * agent, an agent's own page finds one, and a Space's settings lists the machines themselves.
 * Written out per screen, "is this one here" had already been asked two different ways.
 */

import { cached } from '../../api.ts'
import type { components } from '../../generated/api.ts'

export type Machine = components['schemas']['Machine']

/**
 * One installed agent, with the machine it is on carried along.
 *
 * A page names an agent by machine and kind, and shows the machine's name beside it: two Codexes
 * in one Space are two agents, and neither the name nor whether it is reachable belongs to the
 * agent row in the contract.
 */
export type InstalledAgent = {
  readonly machineId: string
  readonly machineName: string
  readonly kind: Machine['agents'][number]['kind']
  readonly name: string | null
  readonly avatarUrl: string
  /** What it lets a person choose for one question. Empty means there is nothing to choose. */
  readonly models: Machine['agents'][number]['models']
  /** Its machine's, not its own: an agent is reachable exactly when the machine holding it is. */
  readonly isHere: boolean
}

/** Every agent this Space can reach, in the order their machines came back. */
export function agentsOn(machines: readonly Machine[]): readonly InstalledAgent[] {
  return machines.flatMap((machine) =>
    machine.agents.map((agent) => ({
      machineId: machine.id,
      machineName: machine.name,
      kind: agent.kind,
      name: agent.name,
      avatarUrl: agent.avatarUrl,
      models: agent.models,
      isHere: machine.presence.state !== 'gone',
    })),
  )
}

export function machinesIn(slug: string) {
  return cached.queryOptions(
    'get',
    '/spaces/{slug}/machines',
    { params: { path: { slug } } },
    {
      // A machine appears after its own process checks in, and connecting one is somebody sitting
      // in front of both screens. Asking again is what lets it appear without a refresh.
      refetchInterval: 3000,
      select: (answer) => answer.machines,
    },
  )
}
