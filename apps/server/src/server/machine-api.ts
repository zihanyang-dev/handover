/**
 * Machines that are already in: what they report, and what a Space screen sees.
 *
 * Two holders, two doors. A machine reports and leaves; a person looks and removes. Neither
 * credential opens the other's routes — the powers are different, and one door for both would be
 * the weaker of the two everywhere.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { Database } from '../db/connection.ts'
import { checkIn, machinesIn, removeMachine, sayGoodbye } from '../db/machine.ts'
import { agentsFound, AGENT_COMMANDS, AGENT_KIND_NAMES } from '../machine/agent-kind.ts'
import { POLL_SECONDS, presence } from '../machine/presence.ts'
import { api, insteadOfMalformed, rowId, saysNothing, sends, takes } from './contract.ts'
import { body, refusal, type Failure } from './failure.ts'
import { requireMachine, type Attached } from './machine-session.ts'
import { requireMember, type InSpace } from './membership.ts'
import { requireSession, type Signed } from './session.ts'

export type MachineApi = { readonly db: Database }

/** An id that names a machine in another Space says what a missing Space says: nothing is here. */
const UNAVAILABLE: Failure<404> = { reason: 'unavailable', recovery: 'start-over', status: 404 }

/**
 * What a machine reports by command name, not by kind.
 *
 * It reports what it actually looked for. Names this deployment does not know are dropped rather
 * than refused: a newer CLI against an older server should be a machine with fewer agents, not a
 * machine that cannot check in.
 */
const reporting = z
  .object({
    found: z
      .array(z.object({ command: z.string().min(1).max(100), version: z.string().min(1).max(100) }))
      .max(50)
      .readonly(),
  })
  .openapi('MachineReport')

const nothingYetBody = z
  .object({
    /**
     * How long to wait before asking again.
     *
     * Told rather than compiled in, so the rate is this deployment's to set. Once there is work to
     * wait for, the server holds the request instead and this becomes how long it holds.
     */
    pollSeconds: z.number().int().positive(),
    /** Which commands to look for. Told every time, so the list can change without a release. */
    lookFor: z.array(z.string()).readonly(),
  })
  .openapi('NothingForThisMachine')

const agentBody = z
  .object({ kind: z.enum(AGENT_KIND_NAMES), version: z.string() })
  .openapi('MachineAgent')

const machineBody = z
  .object({
    id: z.uuid(),
    name: z.string(),
    presence: z.discriminatedUnion('state', [
      z.object({ state: z.literal('here') }),
      z.object({ state: z.literal('gone'), since: z.iso.datetime() }),
    ]),
    agents: z.array(agentBody).readonly(),
  })
  .openapi('Machine')

const machinesBody = z.object({ machines: z.array(machineBody).readonly() }).openapi('Machines')

const poll = createRoute({
  method: 'post',
  path: '/machines/current/poll',
  summary: 'Report what this machine has, and ask whether there is anything for it',
  request: { body: takes(reporting) },
  responses: {
    200: sends(nothingYetBody, 'Nothing for it yet; ask again'),
    400: refusal('The body was not the shape it claims'),
    401: refusal('That is not a live machine credential'),
  },
})

const leave = createRoute({
  method: 'delete',
  path: '/machines/current/session',
  summary: 'Say this machine is stopping on purpose',
  responses: {
    204: saysNothing('Gone, without waiting out the silence'),
    401: refusal('That is not a live machine credential'),
  },
})

const listMachines = createRoute({
  method: 'get',
  path: '/spaces/{slug}/machines',
  summary: 'The machines in this Space',
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: sends(machinesBody, 'Everything attached, here or not'),
    401: refusal('Nobody is signed in here'),
    404: refusal('No such Space'),
  },
})

const detach = createRoute({
  method: 'delete',
  path: '/spaces/{slug}/machines/{id}',
  summary: 'Take a machine out of this Space',
  request: { params: z.object({ slug: z.string(), id: rowId }) },
  responses: {
    204: saysNothing('Out, and its credential stops working'),
    401: refusal('Nobody is signed in here'),
    404: refusal('No such Space, or no such machine in it'),
  },
})

export function machineApi(deps: MachineApi) {
  const inSpace = [requireSession(deps.db), requireMember(deps.db)]
  const attached = requireMachine(deps.db)

  return api<{ Variables: Signed & Attached & InSpace }>()
    .openapi({ ...poll, middleware: [attached] }, async (c) => {
      await checkIn(deps.db, c.get('machineId'), agentsFound(c.req.valid('json').found))

      // Nothing to hand out in this slice. The shape is the one work will arrive in, so adding it
      // is adding to this answer rather than replacing this route.
      return c.json({ pollSeconds: POLL_SECONDS, lookFor: AGENT_COMMANDS }, 200)
    })

    .openapi({ ...leave, middleware: [attached] }, async (c) => {
      await sayGoodbye(deps.db, c.get('machineId'))
      return c.body(null, 204)
    })

    .openapi({ ...listMachines, middleware: inSpace }, async (c) => {
      // `asOf` comes back with them, from the same clock that wrote `last_seen_at`. A `new Date()`
      // here would be this process's clock deciding a fact the database's clock recorded.
      const seen = await machinesIn(deps.db, c.get('space').id)
      const machines = seen.machines.map((machine) => ({
        id: machine.id,
        name: machine.name,
        presence: onTheWire(presence(machine.whereabouts, seen.asOf)),
        agents: machine.agents,
      }))

      return c.json({ machines }, 200)
    })

    .openapi(
      { ...detach, middleware: inSpace },
      async (c) => {
        const removed = await removeMachine(deps.db, c.req.valid('param').id, c.get('space').id)

        // An id from another Space removes nothing, and says the same thing a missing Space says.
        if (!removed) return c.json(body(UNAVAILABLE), UNAVAILABLE.status)

        return c.body(null, 204)
      },
      insteadOfMalformed(UNAVAILABLE),
    )
}

/** A `Date` is not a wire value. Converting here keeps the owner's shape free of transport. */
function onTheWire(where: ReturnType<typeof presence>): z.infer<typeof machineBody>['presence'] {
  return where.state === 'here'
    ? { state: 'here' }
    : { state: 'gone', since: where.since.toISOString() }
}
