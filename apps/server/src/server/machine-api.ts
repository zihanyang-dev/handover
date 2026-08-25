/**
 * Machines that are already in: what they report, and what a Space screen sees.
 *
 * Two holders, two doors. A machine reports and leaves; a person looks and removes. Neither
 * credential opens the other's routes — the powers are different, and one door for both would be
 * the weaker of the two everywhere.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { Database } from '../db/connection.ts'
import { forgetStranded, stopWantedOn, takeOne, type Taken } from '../db/turn.ts'
import { checkIn, machinesIn, removeMachine, sayGoodbye } from '../db/machine.ts'
import { Asked } from '../conversation/transcript.ts'
import {
  agentsFound,
  AGENT_COMMANDS,
  AGENT_KIND_NAMES,
  type AgentKind,
  type Installed,
} from '../machine/agent-kind.ts'
import { POLL_SECONDS, presence } from '../machine/presence.ts'
import {
  api,
  endpointsBehind,
  insteadOfMalformed,
  rowId,
  saysNothing,
  sends,
  takes,
} from './contract.ts'
import {
  BEHIND_A_MACHINE,
  BEHIND_A_SESSION,
  body,
  MALFORMED_BODY,
  refusal,
  type Failure,
  UNAVAILABLE,
} from './failure.ts'
import { requireMachine, type Attached } from './machine-session.ts'
import { modelsBody } from './offers.ts'
import { requireMember, type InSpace } from './membership.ts'
import { requireSession, type Signed } from './session.ts'

export type MachineApi = { readonly db: Database }

/**
 * Not a machine any more.
 *
 * The same answer the door gives, said again by the transaction that writes: a credential can stop
 * being one between the two, and the CLI already knows to stop for good when it hears this.
 */
const NOT_OURS: Failure<401> = { reason: 'no-machine', recovery: 'start-over', status: 401 }

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
      .array(
        z.object({
          command: z.string().min(1).max(100),
          version: z.string().min(1).max(100),
          /**
           * What this version lets a person choose.
           *
           * Absent on nearly every report, and that is the design: asking an agent costs starting
           * it up, so a machine asks only when the version it found is new. Absent means "nothing
           * said about it", which leaves whatever was stored — not "it offers nothing".
           */
          models: modelsBody.optional(),
        }),
      )
      .max(50)
      .readonly(),
    /**
     * This machine has just started.
     *
     * Only it can say so, and it is worth saying: a turn left open on a machine that has just
     * started is one whose agent went on working with nobody watching, and no answer about it can
     * be had from here.
     */
    restarted: z.boolean().optional(),
  })
  .openapi('MachineReport')

/** One question waiting for an answer on this machine. */
const askingBody = z
  .object({
    conversationId: z.uuid(),
    agentKind: z.enum(AGENT_KIND_NAMES),
    /**
     * What the agent calls this conversation, when it has said so.
     *
     * Absent on a first turn, and handed back on every later one — it is how the agent is asked to
     * remember, and how a turn nobody saw the end of can be read back afterwards.
     */
    agentSession: z.string().nullable(),
    /** Where the question sits, so the machine can name what it writes after it. */
    askedSeq: z.number().int(),
    asked: Asked,
  })
  .openapi('SomethingToAnswer')

const checkedInBody = z
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
    /** Absent when there is nothing to do. One at a time: a machine answers one turn at a time. */
    asking: askingBody.optional(),
    /**
     * A conversation somebody has asked this machine to stop working on.
     *
     * Told rather than pushed, because a machine is reached by nothing but its own asking. It
     * keeps being told until the agent says it stopped, which is what makes a stop that arrived
     * while nothing was listening arrive on the next report instead of being lost.
     */
    stopping: z.uuid().optional(),
  })
  .openapi('CheckedIn')

const agentBody = z
  .object({
    kind: z.enum(AGENT_KIND_NAMES),
    version: z.string(),
    /** Empty when this agent does not let you choose, and when nobody has asked it yet. */
    models: modelsBody,
  })
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

/**
 * A question this machine has just taken, as it is told about it.
 *
 * `asked` is parsed on the way out rather than trusted: it went in as JSON, and a row written by
 * an older build is exactly the case where a shape can be wrong. A row that will not parse is one
 * this machine cannot act on, and pretending otherwise sends it a turn it cannot take.
 */
function asAsking(taken: Taken) {
  return {
    conversationId: taken.conversationId,
    agentKind: taken.agentKind as AgentKind,
    agentSession: taken.agentSession,
    askedSeq: taken.askedSeq,
    asked: Asked.parse(taken.asked),
  }
}

const behindAMembership = endpointsBehind<{ Variables: Signed & InSpace }>()
const behindAMachine = endpointsBehind<{ Variables: Attached }>()

export function machineApi(deps: MachineApi) {
  return api<{ Variables: Signed & InSpace }>()
    .openapiRoutes([listing(deps), detaching(deps)])
    .route('/', whatMachinesDo(deps))
}

/**
 * What a machine does for itself.
 *
 * Its own app, because it is behind its own door: a machine's credential is not a person's, and
 * one app holding both would be one `c` that claims to have what only half its routes ever do.
 */
function whatMachinesDo(deps: MachineApi) {
  return api<{ Variables: Attached }>().openapiRoutes([polling(deps), leaving(deps)])
}

/** The one thing a machine ever does unprompted, and so the only way anything reaches it. */
function polling(deps: MachineApi) {
  return behindAMachine({
    route: createRoute({
      method: 'post',
      path: '/machines/current/poll',
      summary: 'Report what this machine has, and ask whether there is anything for it',
      middleware: [requireMachine(deps.db)],
      request: { body: takes(reporting) },
      responses: {
        ...BEHIND_A_MACHINE,
        ...MALFORMED_BODY,
        200: sends(checkedInBody, 'What to look for, and anything waiting'),
      },
    }),

    handler: async (c) => {
      const machineId = c.get('machineId')
      const reported = c.req.valid('json')
      // Removed between the credential being read and this transaction opening: nothing to check
      // in, nothing to take, and the same answer a stranger gets. Waiting for the next request to
      // notice would be one more report, one more turn taken, from a machine somebody took out.
      const still = await checkIn(deps.db, machineId, agentsFound(reported.found))
      if (!still) return c.json(body(NOT_OURS), NOT_OURS.status)

      if (reported.restarted === true) await forgetStranded(deps.db, machineId)

      // The stop first: a machine that is already running a turn has to hear about it, and taking
      // a new one is only worth doing once nothing else is owed.
      const wanted = await stopWantedOn(deps.db, machineId)
      const taken = await takeOne(deps.db, machineId)

      return c.json(
        {
          pollSeconds: POLL_SECONDS,
          lookFor: AGENT_COMMANDS,
          ...(taken === undefined ? {} : { asking: asAsking(taken) }),
          ...(wanted === undefined ? {} : { stopping: wanted }),
        },
        200,
      )
    },
  })
}

/** Going away on purpose, so nobody has to wait out the silence to find out. */
function leaving(deps: MachineApi) {
  return behindAMachine({
    route: createRoute({
      method: 'delete',
      path: '/machines/current/session',
      summary: 'Say this machine is stopping on purpose',
      middleware: [requireMachine(deps.db)],
      responses: {
        ...BEHIND_A_MACHINE,
        204: saysNothing('Gone, without waiting out the silence'),
      },
    }),

    handler: async (c) => {
      await sayGoodbye(deps.db, c.get('machineId'))
      return c.body(null, 204)
    },
  })
}

/** Everything attached to this Space, here or not. */
function listing(deps: MachineApi) {
  return behindAMembership({
    route: createRoute({
      method: 'get',
      path: '/spaces/{slug}/machines',
      summary: 'The machines in this Space',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: { params: z.object({ slug: z.string() }) },
      responses: {
        ...BEHIND_A_SESSION,
        200: sends(machinesBody, 'Everything attached, here or not'),
        404: refusal('No such Space'),
      },
    }),

    handler: async (c) => {
      // `asOf` comes back with them, from the same clock that wrote `last_seen_at`. A `new Date()`
      // here would be this process's clock deciding a fact the database's clock recorded.
      const seen = await machinesIn(deps.db, c.get('space').id)
      const machines = seen.machines.map((machine) => ({
        id: machine.id,
        name: machine.name,
        presence: onTheWire(presence(machine.whereabouts, seen.asOf)),
        agents: machine.agents.map(asOffered),
      }))

      return c.json({ machines }, 200)
    },
  })
}

/** Taking one out, which is also what stops its credential working. */
function detaching(deps: MachineApi) {
  return behindAMembership({
    route: createRoute({
      method: 'delete',
      path: '/spaces/{slug}/machines/{id}',
      summary: 'Take a machine out of this Space',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: { params: z.object({ slug: z.string(), id: rowId }) },
      responses: {
        ...BEHIND_A_SESSION,
        204: saysNothing('Out, and its credential stops working'),
        404: refusal('No such Space, or no such machine in it'),
      },
    }),

    hook: insteadOfMalformed(UNAVAILABLE),

    handler: async (c) => {
      const removed = await removeMachine(deps.db, {
        machine: c.req.valid('param').id,
        space: c.get('space').id,
      })

      // An id from another Space removes nothing, and says the same thing a missing Space says.
      if (!removed) return c.json(body(UNAVAILABLE), UNAVAILABLE.status)

      return c.body(null, 204)
    },
  })
}

/**
 * An agent as a page reads it.
 *
 * The stored list is parsed on the way out rather than trusted: it went in as JSON, and a row
 * written by another build is exactly the case where a shape can be wrong. One that will not parse
 * comes back as no models at all — a page with no control is a page somebody can still use, and a
 * Space screen that will not load because of a model list would not be.
 */
function asOffered(agent: Installed): z.infer<typeof agentBody> {
  const read = modelsBody.safeParse(agent.models)

  return {
    kind: agent.kind,
    version: agent.version,
    models: read.success ? read.data : [],
  }
}

/** A `Date` is not a wire value. Converting here keeps the owner's shape free of transport. */
function onTheWire(where: ReturnType<typeof presence>): z.infer<typeof machineBody>['presence'] {
  return where.state === 'here'
    ? { state: 'here' }
    : { state: 'gone', since: where.since.toISOString() }
}
