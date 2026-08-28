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
 * Three doors. A person opens, hands over and ends work through their Space; the agent running it
 * speaks through its machine's own credential, and the path never names a machine. One endpoint is
 * under neither — the Inbox. Work you handed out is work you answer for wherever it lives, and a
 * person with three Spaces has one Inbox.
 */

import { z } from '@hono/zod-openapi'
import type { Database } from '../db/connection.ts'
import { handOffTo } from '../db/conversation.ts'
import { handWorkTo } from '../db/membership.ts'
import { handOver, stopsWorking, takeBack, waitingOn, writesOutput } from '../db/task.ts'
import { AGENT_KIND_NAMES } from '../machine/agent-kind.ts'
import { type Failure, UNAVAILABLE, refused } from './failure.ts'
import {
  aMachine,
  aMember,
  aPerson,
  anOwner,
  named,
  nothing,
  refuses,
  rowId,
  sends,
} from './route.ts'

export type TaskApi = { readonly db: Database }

/** Something is already running in this conversation. One at a time — see the index that says so. */
const ALREADY: Failure<409> = { reason: 'already-handed-over', recovery: 'start-over', status: 409 }

/** Nothing was handed over here, so there is nothing to take back or to report about. */
const NOT_HANDED_OVER: Failure<409> = {
  reason: 'not-handed-over',
  recovery: 'start-over',
  status: 409,
}

/**
 * Whoever it was handed to is not here, or there is nothing there to hand over.
 *
 * One answer for both, because a handover is written in the statement that checks — and by the
 * time it comes back, "no rows" cannot say which. What to do about either is the same: look at the
 * screen again, which is showing what is actually true.
 */
const CANNOT_HAND_OVER: Failure<404> = {
  reason: 'cannot-hand-over',
  recovery: 'start-over',
  status: 404,
}

/** It is a sub-task itself, and `prd.md` 07 ⑤ says the fanning out stops there. */
const NO_DEEPER: Failure<409> = {
  reason: 'already-a-subtask',
  recovery: 'carry-on-here',
  status: 409,
}

const NO_AGENT: Failure<409> = {
  reason: 'agent-not-on-machine',
  recovery: 'choose-another-agent',
  status: 409,
}

/** What the caller calls this request, so a lost answer is safe to retry. */
const CALLED = { key: z.string().min(1).max(200) }

const goal = z.string().min(1).max(2000)

/**
 * The agent stopping, and why.
 *
 * Three, and `working` is not among them: an agent can stop itself and can never start itself.
 * What starts it again is a person saying something, a piece of work it handed out coming back,
 * or the clock. **The union is the state machine**, so nothing has to explain it a second time.
 */
const HowItStopped = z
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

const Waiting = named('Waiting', {
  conversationId: z.uuid(),
  spaceSlug: z.string(),
  machineName: z.string(),
  goal: z.string(),
  /** What it asked. Null when it stopped without saying — which a page shows as such. */
  asked: z.string().nullable(),
  since: z.iso.datetime(),
})

const Inbox = named('Inbox', { waiting: z.array(Waiting).readonly() })

const HandOver = named('HandOver', { ...CALLED, goal })

const TakeBack = named('TakeBack', CALLED)

/** Who a piece of work is being handed to. */
const HandWorkTo = named('HandWorkTo', { ownerUserId: rowId })

const StopWorking = named('StopWorking', { ...CALLED, how: HowItStopped })

/**
 * No machine. The work opens on the machine the one handing it off is already running on.
 *
 * `prd.md` 07 ⑥: an agent that could name a machine could put work on somebody's laptop with
 * nobody in the room. A person handing you something leaves a name and a time; this would not.
 */
const HandOff = named('HandOff', {
  ...CALLED,
  goal,
  agentKind: z.enum(AGENT_KIND_NAMES),
})

const WorkOpened = named('WorkOpened', { conversationId: z.uuid() })

/** No name of its own: the title in the path is the name, so writing it again replaces it. */
const WriteOutput = named('WriteOutput', { text: z.string().min(1).max(65_536) })

export function taskApi(deps: TaskApi) {
  return [
    handingOver(deps),
    takingBack(deps),
    handingToSomebody(deps),
    inbox(deps),
    stopping(deps),
    handingOff(deps),
    writing(deps),
  ]
}

/** Creating it, which is where a piece of work begins. */
function handingOver({ db }: TaskApi) {
  return aMember(db).post('/spaces/{slug}/conversations/{id}/task', {
    summary: 'Let it carry on without being spoken to',
    params: { id: rowId },
    body: HandOver,
    answers: {
      204: 'Handed over, or handed over already',
      404: refuses(UNAVAILABLE, 'No such Space, or no such conversation in it'),
      409: refuses(ALREADY, 'Something is already running in this conversation'),
    },

    run: async (c) => {
      const asked = c.req.valid('json')
      const over = await handOver(db, {
        conversationId: c.req.valid('param').id,
        spaceId: c.get('space').id,
        key: asked.key,
        userId: c.get('userId'),
        goal: asked.goal,
      })

      if (over.kind === 'no-conversation') return refused(c, UNAVAILABLE)
      if (over.kind === 'already-handed-over') return refused(c, ALREADY)

      return nothing(c, 204)
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
function takingBack({ db }: TaskApi) {
  return aMember(db).delete('/spaces/{slug}/conversations/{id}/task', {
    summary: 'Stop it carrying on, and stop whatever it handed off',
    params: { id: rowId },
    body: TakeBack,
    answers: {
      204: 'Taken back, or taken back already',
      404: refuses(UNAVAILABLE, 'No such Space, no such conversation, and nothing handed over'),
    },

    run: async (c) => {
      const back = await takeBack(db, {
        conversationId: c.req.valid('param').id,
        spaceId: c.get('space').id,
        key: c.req.valid('json').key,
      })

      return back.kind === 'taken-back' ? nothing(c, 204) : refused(c, UNAVAILABLE)
    },
  })
}

/**
 * Handing it to somebody else here — which is also who the Inbox tells, because it is one column.
 *
 * `PATCH` and not a `POST` to some transfer: nothing is created. One field of a thing that already
 * exists says somebody else's name now.
 */
function handingToSomebody({ db }: TaskApi) {
  return anOwner(db).patch('/spaces/{slug}/conversations/{id}/task', {
    summary: 'Hand a piece of work to somebody else here',
    params: { id: rowId },
    body: HandWorkTo,
    answers: {
      204: 'It is theirs, and it is in their Inbox',
      404: refuses(
        CANNOT_HAND_OVER,
        'No such Space, nothing running there, or nobody here by that name',
      ),
    },

    run: async (c) => {
      // Named at the boundary: in a path it is `{id}`, and by the time it reaches the tables it is
      // a conversation. Three opaque ids in one call is where they get swapped.
      const handed = await handWorkTo(db, {
        spaceId: c.get('space').id,
        conversationId: c.req.valid('param').id,
        userId: c.req.valid('json').ownerUserId,
      })
      if (handed.kind === 'not-a-member') return refused(c, CANNOT_HAND_OVER)

      return nothing(c, 204)
    },
  })
}

/** Everything waiting on this person, wherever it is. The only read that is not under a Space. */
function inbox({ db }: TaskApi) {
  return aPerson(db).get('/me/inbox', {
    summary: 'Everything waiting on you, across every Space',
    answers: { 200: sends(Inbox, 'Newest first') },

    run: async (c) => {
      const waiting = await waitingOn(db, c.get('userId'))

      return c.json(
        { waiting: waiting.map((one) => ({ ...one, since: one.since.toISOString() })) },
        200,
      )
    },
  })
}

/** The agent stops working, and says why. The one place a piece of work leaves `working`. */
function stopping({ db }: TaskApi) {
  return aMachine(db).patch('/machines/current/conversations/{id}/task', {
    summary: 'Stop working, and say why',
    params: { id: rowId },
    body: StopWorking,
    answers: {
      204: 'Stopped, or stopped already',
      409: refuses(NOT_HANDED_OVER, 'Nothing was handed over in that conversation'),
    },

    run: async (c) => {
      const asked = c.req.valid('json')
      const stopped = await stopsWorking(
        db,
        { conversationId: c.req.valid('param').id, machineId: c.get('machineId'), key: asked.key },
        asked.how.state === 'sleep'
          ? { state: 'sleep', until: new Date(asked.how.until) }
          : asked.how.state === 'wait'
            ? { state: 'wait', question: asked.how.question }
            : { state: 'done', ending: asked.how.ending, said: asked.how.text },
      )

      return stopped.kind === 'noted' ? nothing(c, 204) : refused(c, NOT_HANDED_OVER)
    },
  })
}

/** The agent opens a piece of work for another agent here, and carries on. */
function handingOff({ db }: TaskApi) {
  return aMachine(db).post('/machines/current/conversations/{id}/task/handed-off', {
    summary: 'Open a piece of work for another agent',
    params: { id: rowId },
    body: HandOff,
    answers: {
      201: sends(WorkOpened, 'Opened, and its machine already knows'),
      404: refuses(UNAVAILABLE, 'Nothing was handed over in that conversation'),
      409: refuses([NO_AGENT, NO_DEEPER], 'This machine cannot take it, or this is already one'),
    },

    run: async (c) => {
      const asked = c.req.valid('json')
      const off = await handOffTo(db, {
        conversationId: c.req.valid('param').id,
        machineId: c.get('machineId'),
        key: asked.key,
        agentKind: asked.agentKind,
        goal: asked.goal,
      })

      if (off.kind === 'nothing-to-hand-off') return refused(c, UNAVAILABLE)
      if (off.kind === 'not-yours-to-hand-off') return refused(c, NO_DEEPER)
      if (off.kind === 'no-agent') return refused(c, NO_AGENT)

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
function writing({ db }: TaskApi) {
  return aMachine(db).put('/machines/current/conversations/{id}/task/outputs/{title}', {
    summary: 'Write something down as a piece of work in its own right',
    params: { id: rowId, title: z.string().min(1).max(200) },
    body: WriteOutput,
    answers: {
      204: 'Written, or revised',
      409: refuses(NOT_HANDED_OVER, 'Nothing was handed over in that conversation'),
    },

    run: async (c) => {
      const where = c.req.valid('param')
      const wrote = await writesOutput(
        db,
        { conversationId: where.id, machineId: c.get('machineId'), key: where.title },
        { title: where.title, body: c.req.valid('json').text },
      )

      return wrote.kind === 'noted' ? nothing(c, 204) : refused(c, NOT_HANDED_OVER)
    },
  })
}
