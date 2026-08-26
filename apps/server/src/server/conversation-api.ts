/**
 * Conversations: opening one, saying something into it, reading it back, and what the machine
 * running it writes.
 *
 * Two holders again, and the same split as machines. A person opens, says and reads through their
 * Space; a machine writes only into the conversation it was handed, and the path never says which
 * machine — its credential does.
 */

import { createRoute, z } from '@hono/zod-openapi'
import { Asked, Message, Spoken, unreadable } from '../conversation/transcript.ts'
import type { Database } from '../db/connection.ts'
import type { Reading, Standing } from '../db/conversation.ts'
import {
  askToStop,
  conversationWith,
  conversationsIn,
  machineSays,
  noteAgentSession,
  openConversation,
  sayTo,
} from '../db/conversation.ts'
import { AGENT_KIND_NAMES } from '../machine/agent-kind.ts'
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
import { modelsBody } from './offers.ts'
import { requireMember, type InSpace } from './membership.ts'
import { requireSession, type Signed } from './session.ts'

export type ConversationApi = { readonly db: Database }

/** Its machine is here, but the agent is not on it any more. Nothing to wait for. */
const NO_AGENT: Failure<409> = {
  reason: 'agent-not-on-machine',
  recovery: 'choose-another-agent',
  status: 409,
}

/** It is part way through the last thing. Waiting is the whole recovery. */
const STILL_ANSWERING: Failure<409> = { reason: 'still-answering', recovery: 'wait', status: 409 }

/**
 * Nobody is there to pick it up, so it is refused now rather than queued for an empty room.
 *
 * Not `wait`, even though waiting is one of the two things that work. Waiting out a closed laptop
 * and waiting out a turn that is nearly done are different amounts of patience, and the page has
 * somewhere else to send this one.
 */
const MACHINE_AWAY: Failure<409> = {
  reason: 'machine-away',
  recovery: 'choose-another-machine',
  status: 409,
}

/** It already stopped, or never started. Either way there is nothing here to interrupt. */
const NOTHING_RUNNING: Failure<409> = {
  reason: 'nothing-to-stop',
  recovery: 'start-over',
  status: 409,
}

const openingBody = z
  .object({ machineId: rowId, agentKind: z.enum(AGENT_KIND_NAMES) })
  .openapi('OpenConversation')

const openedBody = z.object({ id: z.uuid() }).openapi('OpenedConversation')

const workingBody = z
  .discriminatedUnion('state', [
    z.object({ state: z.literal('idle') }),
    z.object({ state: z.literal('working') }),
    z.object({ state: z.literal('unknown') }),
  ])
  .openapi('Working')

const standingBody = z
  .object({
    id: z.uuid(),
    agentKind: z.string(),
    machineId: z.uuid(),
    machineName: z.string(),
    startedAt: z.iso.datetime(),
    /** What was first asked. A conversation nobody has spoken into yet has nothing to show. */
    opening: z.string().nullable(),
    working: workingBody,
  })
  .openapi('Conversation')

const standingsBody = z
  .object({ conversations: z.array(standingBody).readonly() })
  .openapi('Conversations')

/**
 * One thing said, as a page reads it.
 *
 * The shape of a line is part of the contract, per role — otherwise every page that renders one
 * has to write down what a tool call holds, and a hand-written copy of a contract is the thing
 * this repository refuses everywhere else.
 *
 * A line this build cannot read still comes back, as an activity that says so: refusing to open
 * a conversation because one line in it is unfamiliar would lose the whole of it over the least
 * of it. That door stays open on purpose — an activity type nobody has heard of is a value, not
 * a release.
 */
const spokenBody = Spoken.openapi('Message')

const readingBody = z
  .object({
    id: z.uuid(),
    agentKind: z.string(),
    machineName: z.string(),
    working: workingBody,
    /**
     * What this agent lets a person choose, one question at a time.
     *
     * Empty means there is nothing to choose and the page shows no control — which covers both an
     * agent that does not offer a choice and one nobody has asked yet. Saying nothing is always
     * allowed, and means the agent's own default.
     */
    offers: modelsBody,
    messages: z.array(spokenBody).readonly(),
  })
  .openapi('Transcript')

/**
 * A message and the name it goes by.
 *
 * The name is the caller's, not ours: only they know that the message they are sending now is the
 * one they already sent and never heard back about.
 */
const sayingBody = z.object({ key: z.string().min(1).max(200), asked: Asked }).openapi('SayThis')

const stoppingBody = z.object({ key: z.string().min(1).max(200) }).openapi('StopThis')

const reportingBody = z
  .object({ key: z.string().min(1).max(200), message: Message })
  .openapi('MachineMessage')

const namingBody = z.object({ session: z.string().min(1).max(200) }).openapi('AgentSession')

/**
 * A stored conversation as the wire carries it.
 *
 * Everything is parsed on the way out rather than trusted. It all went in as JSON, and a row
 * written by another build is exactly where a shape can be wrong — the difference between the two
 * failures is what each costs: a list of models that will not read is nothing to choose from, and
 * a page with no control still works; a line that will not read is one line, and the rest of the
 * conversation is still what happened.
 */
function asTranscript(reading: Reading) {
  const offers = modelsBody.safeParse(reading.offers)

  return {
    ...reading,
    offers: offers.success ? offers.data : [],
    messages: reading.messages.map((one) => {
      const read = Spoken.safeParse({ ...one, at: one.at.toISOString() })
      return read.success ? read.data : unreadable(one.seq, one.at)
    }),
  }
}

function asStanding(standing: Standing) {
  return { ...standing, startedAt: standing.startedAt.toISOString() }
}

/**
 * A member of this Space, and a machine that was given one of its conversations.
 *
 * Said once each. Every endpoint below is behind one of these two doors and says only what is its
 * own — which of them it is behind is the one thing that decides what `c` holds, and repeating it
 * at each endpoint would be the same fact with seven places to drift.
 */
const behindAMembership = endpointsBehind<{ Variables: Signed & InSpace }>(SHOWS.session)
const behindAMachine = endpointsBehind<{ Variables: Attached }>(SHOWS.machine)

export function conversationApi(deps: ConversationApi) {
  return api<{ Variables: Signed & InSpace }>()
    .openapiRoutes([listing(deps), reading(deps), opening(deps), saying(deps), stopping(deps)])
    .route('/', whatMachinesReport(deps))
}

/**
 * What the machine running a conversation writes back.
 *
 * Its own app, because it is behind its own door: a machine's credential is not a person's, and
 * one app holding both would be one `c` that claims to have what only half its routes ever do.
 */
function whatMachinesReport(deps: ConversationApi) {
  return api<{ Variables: Attached }>().openapiRoutes([reporting(deps), naming(deps)])
}

/** Everything in this Space, newest first. */
function listing(deps: ConversationApi) {
  return behindAMembership({
    route: createRoute({
      method: 'get',
      path: '/spaces/{slug}/conversations',
      summary: 'The conversations in this Space',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: { params: z.object({ slug: z.string() }) },
      responses: {
        ...BEHIND_A_SESSION,
        200: sends(standingsBody, 'Newest first, each with whether it is being worked on'),
        404: refusal('No such Space'),
      },
    }),

    handler: async (c) => {
      const conversations = await conversationsIn(deps.db, c.get('space').id)

      return c.json({ conversations: conversations.map(asStanding) }, 200)
    },
  })
}

/** One conversation and everything said in it. Reading changes nothing, so nothing is refused. */
function reading(deps: ConversationApi) {
  return behindAMembership({
    route: createRoute({
      method: 'get',
      path: '/spaces/{slug}/conversations/{id}',
      summary: 'Everything said in one conversation',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: {
        params: z.object({ slug: z.string(), id: rowId }),
        query: z.object({
          /**
           * The last line the reader already has.
           *
           * Everything past it is everything they are missing, because a transcript is only
           * appended to. Left out, they get all of it — which is what somebody opening a
           * conversation for the first time wants, and what asking again every second is not.
           */
          after: z.coerce.number().int().min(0).optional(),
        }),
      },
      responses: {
        ...BEHIND_A_SESSION,
        200: sends(readingBody, 'In order, oldest first'),
        404: refusal('No such Space, or no such conversation in it'),
      },
    }),

    handler: async (c) => {
      const transcript = await conversationWith(deps.db, {
        conversationId: c.req.valid('param').id,
        spaceId: c.get('space').id,
        after: c.req.valid('query').after,
      })

      return transcript === undefined
        ? c.json(body(UNAVAILABLE), UNAVAILABLE.status)
        : c.json(asTranscript(transcript), 200)
    },
  })
}

/** Starting one, which pins it to an agent on a machine for as long as it exists. */
function opening(deps: ConversationApi) {
  return behindAMembership({
    route: createRoute({
      method: 'post',
      path: '/spaces/{slug}/conversations',
      summary: 'Start a conversation with one agent on one machine',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: { params: z.object({ slug: z.string() }), body: takes(openingBody) },
      responses: {
        ...BEHIND_A_SESSION,
        ...MALFORMED_BODY,
        201: sends(openedBody, 'Open, and pinned to that agent for good'),
        404: refusal('No such Space, or no such machine in it'),
        409: refusal('That machine does not have that agent'),
      },
    }),

    handler: async (c) => {
      const asked = c.req.valid('json')
      const opened = await openConversation(deps.db, {
        spaceId: c.get('space').id,
        machineId: asked.machineId,
        agentKind: asked.agentKind,
      })

      if (opened.kind === 'no-machine') return c.json(body(UNAVAILABLE), UNAVAILABLE.status)
      if (opened.kind === 'no-agent') return c.json(body(NO_AGENT), NO_AGENT.status)

      return c.json({ id: opened.conversationId }, 201)
    },
  })
}

/** Saying something, which only lands when the agent is free to hear it. */
function saying(deps: ConversationApi) {
  return behindAMembership({
    route: createRoute({
      method: 'post',
      path: '/spaces/{slug}/conversations/{id}/messages',
      summary: 'Say something to the agent',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: { params: z.object({ slug: z.string(), id: rowId }), body: takes(sayingBody) },
      responses: {
        ...BEHIND_A_SESSION,
        ...MALFORMED_BODY,
        204: saysNothing('Said, or said already — either way it is in there once'),
        404: refusal('No such Space, or no such conversation in it'),
        409: refusal('It is still answering, or its machine is not here'),
      },
    }),

    handler: async (c) => {
      const asked = c.req.valid('json')
      const landed = await sayTo(
        deps.db,
        { conversationId: c.req.valid('param').id, spaceId: c.get('space').id, key: asked.key },
        asked.asked,
      )

      if (landed.kind === 'no-conversation') return c.json(body(UNAVAILABLE), UNAVAILABLE.status)
      if (landed.kind === 'still-answering') {
        return c.json(body(STILL_ANSWERING), STILL_ANSWERING.status)
      }
      if (landed.kind === 'machine-away') return c.json(body(MACHINE_AWAY), MACHINE_AWAY.status)

      return c.body(null, 204)
    },
  })
}

/** Asking it to stop, which is allowed only while there is something to stop. */
function stopping(deps: ConversationApi) {
  return behindAMembership({
    route: createRoute({
      method: 'post',
      path: '/spaces/{slug}/conversations/{id}/stop',
      summary: 'Ask the agent to stop what it is doing',
      middleware: [requireSession(deps.db), requireMember(deps.db)],
      request: { params: z.object({ slug: z.string(), id: rowId }), body: takes(stoppingBody) },
      responses: {
        ...BEHIND_A_SESSION,
        ...MALFORMED_BODY,
        204: saysNothing('Asked, or asked already'),
        404: refusal('No such Space, or no such conversation in it'),
        409: refusal('Nothing is running in it'),
      },
    }),

    handler: async (c) => {
      const asked = await askToStop(deps.db, {
        conversationId: c.req.valid('param').id,
        spaceId: c.get('space').id,
        key: c.req.valid('json').key,
      })

      if (asked.kind === 'no-conversation') return c.json(body(UNAVAILABLE), UNAVAILABLE.status)
      if (asked.kind === 'nothing-to-stop') {
        return c.json(body(NOTHING_RUNNING), NOTHING_RUNNING.status)
      }

      return c.body(null, 204)
    },
  })
}

/** What the agent said or did. The path never names a machine — its credential does. */
function reporting(deps: ConversationApi) {
  return behindAMachine({
    route: createRoute({
      method: 'post',
      path: '/machines/current/conversations/{id}/messages',
      summary: 'Add what the agent said or did',
      middleware: [requireMachine(deps.db)],
      request: { params: z.object({ id: rowId }), body: takes(reportingBody) },
      responses: {
        ...BEHIND_A_MACHINE,
        ...MALFORMED_BODY,
        204: saysNothing('Written, or already written'),
        404: refusal('That conversation was not given to this machine'),
      },
    }),

    handler: async (c) => {
      const sent = c.req.valid('json')
      const written = await machineSays(deps.db, {
        conversationId: c.req.valid('param').id,
        machineId: c.get('machineId'),
        key: sent.key,
        message: sent.message,
      })

      return written.kind === 'no-conversation'
        ? c.json(body(UNAVAILABLE), UNAVAILABLE.status)
        : c.body(null, 204)
    },
  })
}

/** What the agent calls a conversation, which is how a later turn asks it to remember. */
function naming(deps: ConversationApi) {
  return behindAMachine({
    route: createRoute({
      method: 'put',
      path: '/machines/current/conversations/{id}/session',
      summary: 'Record what the agent calls this conversation',
      middleware: [requireMachine(deps.db)],
      request: { params: z.object({ id: rowId }), body: takes(namingBody) },
      responses: {
        ...BEHIND_A_MACHINE,
        ...MALFORMED_BODY,
        204: saysNothing('Kept, unless it already had one'),
      },
    }),

    handler: async (c) => {
      await noteAgentSession(deps.db, {
        conversationId: c.req.valid('param').id,
        machineId: c.get('machineId'),
        session: c.req.valid('json').session,
      })

      return c.body(null, 204)
    },
  })
}
