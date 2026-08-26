/**
 * Machines that are already in: what they report, and what a Space screen sees.
 *
 * Two holders, two doors. A machine reports and leaves; a person looks and removes. Neither
 * credential opens the other's routes — the powers are different, and one door for both would be
 * the weaker of the two everywhere.
 */

import { createRoute, z } from '@hono/zod-openapi'
import type { Database } from '../db/connection.ts'
import { forgetStranded, openTurnsOn, stopWantedOn, takeOne, type Taken } from '../db/turn.ts'
import { checkIn, machinesIn, removeMachine, sayGoodbye } from '../db/machine.ts'
import { Asked } from '../conversation/transcript.ts'
import {
  agentsFound,
  AGENT_COMMANDS,
  AGENT_KIND_NAMES,
  type AgentKind,
  type Installed,
} from '../machine/agent-kind.ts'
import { presence } from '../machine/presence.ts'
import {
  SHOWS,
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
import type { Waiting } from './waiting.ts'
import { modelsBody } from './offers.ts'
import { requireMember, type InSpace } from './membership.ts'
import { requireSession, type Signed } from './session.ts'

export type MachineApi = {
  readonly db: Database
  /** The questions this instance is holding. Not a fact, so it is not in the database. */
  readonly waiting: Waiting
}

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
    /**
     * Which build of the CLI this is.
     *
     * Optional so that a machine older than this field can still check in — the same reason a
     * command this deployment does not know is dropped rather than refused. Absent is recorded as
     * absent: a machine that cannot say which build it is has answered the question.
     */
    version: z.string().min(1).max(100).optional(),
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

/** Which turn a stop is about. Both halves, so a stop cannot be applied to a later turn. */
const stoppingBody = z
  .object({ conversationId: z.uuid(), askedSeq: z.number().int() })
  .openapi('StopWanted')

const checkedInBody = z
  .object({
    /**
     * How long to wait before asking again.
     *
     * Zero because this deployment holds the question instead: the answer to "is there anything
     * for me" does not come back until there is, or until the hold is up. A machine that also
     * slept would double the gap, and be counted as gone halfway through it.
     */
    pollSeconds: z.number().int().nonnegative(),
    /** Which commands to look for. Told every time, so the list can change without a release. */
    lookFor: z.array(z.string()).readonly(),
    /** Absent when there is nothing to do. One at a time: a machine answers one turn at a time. */
    asking: askingBody.optional(),
    /**
     * The turn somebody has asked this machine to stop working on.
     *
     * The turn and not just the conversation: a stop read a moment before the turn it was about
     * ended would otherwise stop whatever that machine picked up next, and leave that one claimed
     * with nobody running it.
     *
     * Told rather than pushed, because a machine is reached by nothing but its own asking. It
     * keeps being told until the agent says it stopped, which is what makes a stop that arrived
     * while nothing was listening arrive on the next report instead of being lost.
     */
    stopping: stoppingBody.optional(),
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
    /**
     * Which build of the CLI it is running.
     *
     * Absent when it has never said, which is a build older than the field itself. Shown as such
     * rather than filled in — a version this deployment guessed would be read as one it was told.
     */
    version: z.string().optional(),
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

const behindAMembership = endpointsBehind<{ Variables: Signed & InSpace }>(SHOWS.session)
const behindAMachine = endpointsBehind<{ Variables: Attached }>(SHOWS.machine)

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

/**
 * What this machine is owed right now, waiting for it if there is nothing yet.
 *
 * The wait is what makes the whole journey feel like one: without it, everything anybody says
 * sits until the machine next asks, and that gap is the delay a person feels between pressing
 * send and the agent starting.
 */
async function anythingFor(deps: MachineApi, machineId: string) {
  const owed = await deps.waiting.somethingFor(machineId, async () =>
    whatIsOwed(deps.db, machineId),
  )

  return {
    // Nothing, because the waiting happened here. A machine that slept as well would report half
    // as often as this deployment thinks it does, and be counted gone halfway through its own
    // hold.
    pollSeconds: 0,
    lookFor: AGENT_COMMANDS,
    ...owed,
  }
}

/**
 * Anything this machine has to be told, or nothing.
 *
 * A question is only taken for a machine with nothing open, and whether it has is the ledger's to
 * say rather than the machine's. Asked of the machine, the answer is stale the moment it finishes
 * — and it answers one at a time and ignores anything else it is handed, so a second question
 * would be written down as taken by somebody who will never run it, leaving that conversation
 * working until the machine restarts.
 *
 * The stop is asked either way, and first: a machine that is busy is exactly the one somebody
 * wants to stop.
 */
async function whatIsOwed(db: Database, machineId: string) {
  const wanted = await stopWantedOn(db, machineId)
  if (wanted !== undefined) return { stopping: wanted }

  const running = await openTurnsOn(db, machineId)
  if (running.length > 0) return undefined

  const taken = await takeOne(db, machineId)
  return taken === undefined ? undefined : { asking: asAsking(taken) }
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
      const still = await checkIn(deps.db, machineId, {
        version: reported.version,
        found: agentsFound(reported.found),
      })
      if (!still) return c.json(body(NOT_OURS), NOT_OURS.status)

      if (reported.restarted === true) await forgetStranded(deps.db, machineId)

      return c.json(await anythingFor(deps, machineId), 200)
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
        ...(machine.version === undefined ? {} : { version: machine.version }),
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
