/**
 * A piece of work somebody handed over, and everything that happens to it once they walked away.
 *
 * **No path here has a verb in it.** Handing over is creating the piece of work; taking it back
 * is ending it; the agent stopping is changing its state; handing a piece off is creating another
 * one; writing something down is putting it at its own name. Every one of them is the ordinary
 * method for what it does, on the thing it actually touches — which is the point of
 * [AIP-136](https://google.aip.dev/136): a custom verb is for what cannot be said this way, and
 * none of this is.
 *
 * That is not decoration. Six verbs would have been six places to remember the third thing each
 * of them has to do; one of them forgot, and a piece of work sat waiting on an owner who was
 * never told. As one `PATCH` it is one rule with one place to forget.
 *
 * Two doors, and the same split as everywhere else: a person opens and ends work through their
 * Space; the agent running it speaks through its machine's own credential, and the path never
 * names a machine. One endpoint is under neither — the Inbox. Work you handed out is work you
 * answer for wherever it lives, and a person with three Spaces has one Inbox.
 */

import { createRoute, z } from '@hono/zod-openapi'
import { AGENT_KIND_NAMES } from '../machine/agent-kind.ts'
import type { Database } from '../db/connection.ts'
import { handOffTo } from '../db/conversation.ts'
import { handOver, stopsWorking, takeBack, waitingOn, writesOutput } from '../db/task.ts'
import { SHOWS, api, endpointsBehind, rowId, saysNothing, sends, takes } from './contract.ts'
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
import { requireMember, type InSpace } from './membership.ts'
import { requireSession, type Signed } from './session.ts'

export type TaskApi = { readonly db: Database }

/** Something is already running in this conversation. One at a time — see the index that says so. */
const ALREADY: Failure<409> = {
  reason: 'already-handed-over',
  recovery: 'start-over',
  status: 409,
}

/** Nothing was handed over here, so there is nothing to take back or to report about. */
const NOT_HANDED_OVER: Failure<409> = {
  reason: 'not-handed-over',
  recovery: 'start-over',
  status: 409,
}

const NO_MACHINE: Failure<409> = {
  reason: 'no-such-machine',
  recovery: 'choose-another-machine',
  status: 409,
}

const NO_AGENT: Failure<409> = {
  reason: 'agent-not-on-machine',
  recovery: 'choose-another-agent',
  status: 409,
}

const named = { key: z.string().min(1).max(200) }
const goal = z.string().min(1).max(2000)

const handingOverBody = z.object({ ...named, goal }).openapi('HandOver')
const takingBackBody = z.object(named).openapi('TakeBack')

/**
 * The agent stopping, and why.
 *
 * Three, and `working` is not among them: an agent can stop itself and can never start itself.
 * What starts it again is a person saying something, a piece of work it handed out coming back,
 * or the clock. **The union is the state machine**, so nothing has to explain it a second time.
 */
const howBody = z
  .discriminatedUnion('state', [
    z.object({ state: z.literal('wait'), question: z.string().min(1).max(4000) }),
    z.object({ state: z.literal('sleep'), until: z.iso.datetime() }),
    z.object({
      state: z.literal('done'),
      ending: z.enum(['done', 'cannot']),
      text: z.string().min(1).max(4000),
    }),
  ])
  .openapi('HowItStopped')

const stoppingBody = z.object({ ...named, how: howBody }).openapi('StopWorking')

const handingOffBody = z
  .object({
    ...named,
    goal,
    machine: z.string().min(1).max(200),
    agentKind: z.enum(AGENT_KIND_NAMES),
  })
  .openapi('HandOff')

/** No name of its own: the title in the path is the name, so writing it again replaces it. */
const writingBody = z.object({ text: z.string().min(1).max(65_536) }).openapi('WriteOutput')

const openedBody = z.object({ conversationId: z.uuid() }).openapi('HandedOff')

const waitingBody = z
  .object({
    conversationId: z.uuid(),
    spaceSlug: z.string(),
    machineName: z.string(),
    goal: z.string(),
    /** What it asked. Null when it stopped without saying — which a page shows as such. */
    asked: z.string().nullable(),
    since: z.iso.datetime(),
  })
  .openapi('Waiting')

const inboxBody = z.object({ waiting: z.array(waitingBody).readonly() }).openapi('Inbox')

const behindAMembership = endpointsBehind<{ Variables: Signed & InSpace }>(SHOWS.session)
const behindASession = endpointsBehind<{ Variables: Signed }>(SHOWS.session)
const behindAMachine = endpointsBehind<{ Variables: Attached }>(SHOWS.machine)

export function taskApi(deps: TaskApi) {
  return api<{ Variables: Signed & InSpace }>()
    .openapiRoutes([handingOver(deps), takingBack(deps)])
    .route('/', api<{ Variables: Signed }>().openapiRoutes([inbox(deps)]))
    .route('/', whatAgentsSay(deps))
}

function whatAgentsSay(deps: TaskApi) {
  return api<{ Variables: Attached }>().openapiRoutes([
    stopping(deps),
    handingOff(deps),
    writing(deps),
  ])
}

/** Creating it, which is where a piece of work begins. */
function handingOver(deps: TaskApi) {
  return behindAMembership({
    route: createRoute({
      method: 'post',
      path: '/spaces/{slug}/conversations/{id}/task',
      summary: 'Let it carry on without being spoken to',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: { params: z.object({ slug: z.string(), id: rowId }), body: takes(handingOverBody) },
      responses: {
        ...BEHIND_A_SESSION,
        ...MALFORMED_BODY,
        204: saysNothing('Handed over, or handed over already'),
        404: refusal('No such Space, or no such conversation in it'),
        409: refusal('Something is already running in this conversation'),
      },
    }),

    handler: async (c) => {
      const asked = c.req.valid('json')
      const over = await handOver(deps.db, {
        conversationId: c.req.valid('param').id,
        spaceId: c.get('space').id,
        key: asked.key,
        userId: c.get('userId'),
        goal: asked.goal,
      })

      if (over.kind === 'no-conversation') return c.json(body(UNAVAILABLE), UNAVAILABLE.status)
      if (over.kind === 'already-handed-over') return c.json(body(ALREADY), ALREADY.status)

      return c.body(null, 204)
    },
  })
}

/**
 * Ending it, which ends everything it handed out with it.
 *
 * A `DELETE` that cascades is what `DELETE` means, and the row stays where it is — what goes away
 * is the piece of work underway, which is the only one anything ever asks about. The name still
 * comes in a body, because in this system a lost answer must be safe to retry, and that matters
 * more than a `DELETE` with nothing in it.
 */
function takingBack(deps: TaskApi) {
  return behindAMembership({
    route: createRoute({
      method: 'delete',
      path: '/spaces/{slug}/conversations/{id}/task',
      summary: 'Stop it carrying on, and stop whatever it handed off',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: { params: z.object({ slug: z.string(), id: rowId }), body: takes(takingBackBody) },
      responses: {
        ...BEHIND_A_SESSION,
        ...MALFORMED_BODY,
        204: saysNothing('Taken back, or taken back already'),
        404: refusal('No such Space, no such conversation, and nothing handed over in it'),
      },
    }),

    handler: async (c) => {
      const back = await takeBack(deps.db, {
        conversationId: c.req.valid('param').id,
        spaceId: c.get('space').id,
        key: c.req.valid('json').key,
      })

      return back.kind === 'taken-back'
        ? c.body(null, 204)
        : c.json(body(UNAVAILABLE), UNAVAILABLE.status)
    },
  })
}

/** Everything waiting on this person, wherever it is. The only read that is not under a Space. */
function inbox(deps: TaskApi) {
  return behindASession({
    route: createRoute({
      method: 'get',
      path: '/me/inbox',
      summary: 'Everything waiting on you, across every Space',
      middleware: [requireSession(deps.db)],
      request: {},
      responses: {
        ...BEHIND_A_SESSION,
        200: sends(inboxBody, 'Newest first'),
      },
    }),

    handler: async (c) => {
      const waiting = await waitingOn(deps.db, c.get('userId'))

      return c.json(
        { waiting: waiting.map((one) => ({ ...one, since: one.since.toISOString() })) },
        200,
      )
    },
  })
}

/** The agent stops working, and says why. The one place a piece of work leaves `working`. */
function stopping(deps: TaskApi) {
  return behindAMachine({
    route: createRoute({
      method: 'patch',
      path: '/machines/current/conversations/{id}/task',
      summary: 'Stop working, and say why',
      middleware: [requireMachine(deps.db)],
      request: { params: z.object({ id: rowId }), body: takes(stoppingBody) },
      responses: {
        ...BEHIND_A_MACHINE,
        ...MALFORMED_BODY,
        204: saysNothing('Stopped, or stopped already'),
        409: refusal('Nothing was handed over in that conversation'),
      },
    }),

    handler: async (c) => {
      const asked = c.req.valid('json')
      const stopped = await stopsWorking(
        deps.db,
        { conversationId: c.req.valid('param').id, machineId: c.get('machineId'), key: asked.key },
        asked.how.state === 'sleep'
          ? { state: 'sleep', until: new Date(asked.how.until) }
          : asked.how.state === 'wait'
            ? { state: 'wait', question: asked.how.question }
            : { state: 'done', ending: asked.how.ending, said: asked.how.text },
      )

      return stopped.kind === 'noted'
        ? c.body(null, 204)
        : c.json(body(NOT_HANDED_OVER), NOT_HANDED_OVER.status)
    },
  })
}

/** The agent opens a piece of work for another agent, and carries on. */
function handingOff(deps: TaskApi) {
  return behindAMachine({
    route: createRoute({
      method: 'post',
      path: '/machines/current/conversations/{id}/task/handed-off',
      summary: 'Open a piece of work for another agent',
      middleware: [requireMachine(deps.db)],
      request: { params: z.object({ id: rowId }), body: takes(handingOffBody) },
      responses: {
        ...BEHIND_A_MACHINE,
        ...MALFORMED_BODY,
        201: sends(openedBody, 'Opened, and its machine already knows'),
        404: refusal('Nothing was handed over in that conversation'),
        409: refusal('No such machine here, or it does not have that agent'),
      },
    }),

    handler: async (c) => {
      const asked = c.req.valid('json')
      const off = await handOffTo(deps.db, {
        conversationId: c.req.valid('param').id,
        machineId: c.get('machineId'),
        key: asked.key,
        machine: asked.machine,
        agentKind: asked.agentKind,
        goal: asked.goal,
      })

      if (off.kind === 'nothing-to-hand-off') return c.json(body(UNAVAILABLE), UNAVAILABLE.status)
      if (off.kind === 'no-machine') return c.json(body(NO_MACHINE), NO_MACHINE.status)
      if (off.kind === 'no-agent') return c.json(body(NO_AGENT), NO_AGENT.status)

      return c.json({ conversationId: off.conversationId }, 201)
    },
  })
}

/**
 * Something it wrote on purpose, put at its own name.
 *
 * A `PUT` at the title, so writing the same one again replaces it — a three-day report gets its
 * opening on the first day and its conclusion on the third and stays one document. Nothing here
 * carries a name to be idempotent under, because the address already is one.
 */
function writing(deps: TaskApi) {
  return behindAMachine({
    route: createRoute({
      method: 'put',
      path: '/machines/current/conversations/{id}/task/outputs/{title}',
      summary: 'Write something down as a piece of work in its own right',
      middleware: [requireMachine(deps.db)],
      request: {
        params: z.object({ id: rowId, title: z.string().min(1).max(200) }),
        body: takes(writingBody),
      },
      responses: {
        ...BEHIND_A_MACHINE,
        ...MALFORMED_BODY,
        204: saysNothing('Written, or revised'),
        409: refusal('Nothing was handed over in that conversation'),
      },
    }),

    handler: async (c) => {
      const where = c.req.valid('param')
      const wrote = await writesOutput(
        deps.db,
        { conversationId: where.id, machineId: c.get('machineId'), key: where.title },
        { title: where.title, body: c.req.valid('json').text },
      )

      return wrote.kind === 'noted'
        ? c.body(null, 204)
        : c.json(body(NOT_HANDED_OVER), NOT_HANDED_OVER.status)
    },
  })
}
