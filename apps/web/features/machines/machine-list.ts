/**
 * The machines one Space can reach, and the agents on them.
 *
 * Both shapes live here because both are read by more than one screen — the sidebar lists every
 * agent, an agent's own page finds one, and a Space's settings lists the machines themselves.
 * Written out per screen, "is this one here" had already been asked two different ways.
 */

import { useQueryClient } from '@tanstack/react-query'
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

/**
 * Disconnecting one of your own, which is also what stops its credential working.
 *
 * Yours, not a Space's: a machine belongs to whoever connected it. The path says `/me` for that
 * reason, and no Space appears in it — but every Space it was reachable from has to read its
 * machines again, and the one on screen is the one somebody is looking at.
 */
export function useDisconnectMachine(slug: string) {
  const client = useQueryClient()

  return cached.useMutation('delete', '/me/machines/{id}', {
    onSuccess: async () => client.invalidateQueries({ queryKey: machinesIn(slug).queryKey }),
  })
}

/**
 * Naming an agent on one of your machines, or putting the name back.
 *
 * The name follows its owner rather than the Space it is being looked at from: the same laptop
 * appears in every Space that person is in, and one called something different in each would be a
 * different agent to each room. `null` is the only way to take a name off.
 */
export function useNameAgent(slug: string) {
  const client = useQueryClient()

  return cached.useMutation('patch', '/me/machines/{id}/agents/{kind}', {
    onSuccess: async () => client.invalidateQueries({ queryKey: machinesIn(slug).queryKey }),
  })
}

/**
 * Handing a machine to somebody else here.
 *
 * An owner's, and the thing to do *before* taking its owner out: removing the person first would
 * take the machine with them, which is Tailscale's lesson — deleting a user deletes their devices
 * and everything running on them stops.
 */
export function useHandMachineTo(slug: string) {
  const client = useQueryClient()

  return cached.useMutation('patch', '/spaces/{slug}/machines/{id}', {
    onSuccess: async () => client.invalidateQueries({ queryKey: machinesIn(slug).queryKey }),
  })
}
